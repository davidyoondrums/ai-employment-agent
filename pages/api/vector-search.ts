import type { NextApiRequest, NextApiResponse } from 'next'
import { codeBlock, oneLine } from 'common-tags'
import OpenAI, { APIError } from 'openai'
import { ApplicationError, UserError } from '@/lib/errors'
import { readMdxFiles } from '@/lib/read-mdx-files'

const openAiKey = process.env.OPENAI_KEY

// Set OPENAI_MODEL to change models without a code deploy. The default is the
// cost-optimised tier, which is roughly an order of magnitude cheaper than
// gpt-4o for this workload and comfortably capable enough to answer questions
// about a resume. Deliberately an undated alias rather than a dated snapshot:
// OpenAI retires snapshots on a schedule but moves aliases forward, so this
// does not need revisiting every time a new version ships.
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o'
const MAX_OUTPUT_TOKENS = 512

// Two parameters differ by model generation, in opposite directions, so there
// is no single set that works everywhere:
//
//   max_tokens          deprecated, and rejected by GPT-5 and later
//   max_completion_tokens   rejected by legacy models such as gpt-4o
//   temperature         rejected outright by GPT-5 and later, which fix it
//                       at 1 ("Unsupported parameter: 'temperature' is not
//                       supported with this model")
//
// Derive both from the model so OPENAI_MODEL stays a setting that can be
// changed safely rather than a way to 400 every request.
const LEGACY_PARAM_MODELS = /^(gpt-4o|gpt-4$|gpt-4-|gpt-3\.5)/

function modelParams(model: string) {
  return LEGACY_PARAM_MODELS.test(model)
    ? { max_tokens: MAX_OUTPUT_TOKENS, temperature: 0 }
    : { max_completion_tokens: MAX_OUTPUT_TOKENS }
}

// The deployed function is capped at 60s (see vercel.json). The SDK obeys a
// 429's Retry-After, which OpenAI can set to tens of seconds, so leaving the
// defaults lets a throttled request sleep straight past that cap and return
// nothing at all.
//
// Retrying in here cannot help the case that actually occurs: a rate limit
// that needs a 40s wait will not have cleared by the time the budget runs
// out, and every second spent asleep is a second not spent streaming the
// answer. Fail fast instead and let the caller ask again -- the 429 response
// says as much, and carries Retry-After when OpenAI supplies it.
const REQUEST_TIMEOUT_MS = 45_000
const MODERATION_TIMEOUT_MS = 5_000

const openai = new OpenAI({
  apiKey: openAiKey,
  maxRetries: 0,
  timeout: REQUEST_TIMEOUT_MS,
})

// The knowledge base ships with the deployment and never changes at runtime,
// so read and parse it once per instance rather than on every request.
let mdxContentPromise: Promise<string> | undefined

function getMdxContent(): Promise<string> {
  if (!mdxContentPromise) {
    mdxContentPromise = readMdxFiles().catch((error) => {
      // Don't cache a failure - let the next request retry.
      mdxContentPromise = undefined
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.error('Failed to load MDX files:', errorMessage)
      throw new ApplicationError(
        'Failed to load knowledge base content. Please try again later.',
        { originalError: errorMessage }
      )
    })
  }
  return mdxContentPromise
}

function isRateLimit(err: unknown): err is APIError {
  return err instanceof APIError && err.status === 429
}

/**
 * Escapes a chunk for the `ai` package's data stream protocol, where each part
 * is `<code>:<json value>\n`.
 */
function streamPart(code: number, value: string) {
  return `${code}:${JSON.stringify(value)}\n`
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Tracks whether we've committed the response headers. Once we have, we can
  // no longer send a JSON error - it has to go out as a stream part instead.
  let streaming = false

  try {
    // Parse request body - Next.js automatically parses JSON body for us
    const { prompt: query } = req.body

    if (!query) {
      throw new UserError('Missing query in request data')
    }

    const sanitizedQuery = query.trim()

    // Do all the fallible preflight work *before* committing response headers,
    // so failures can still be reported with a real status code.
    const [moderationResult, mdxContent] = await Promise.all([
      // Moderation is a free safety check, not a core dependency. If the API
      // itself is unavailable (429/5xx) we log and continue rather than taking
      // down the whole request - but a genuine flag still blocks.
      openai.moderations
        // Never retried: the call fails open, so a retry only burns budget.
        .create({ input: sanitizedQuery }, { maxRetries: 0, timeout: MODERATION_TIMEOUT_MS })
        .then((response) => response.results?.[0])
        .catch((error: unknown) => {
          console.error(
            'Moderation check unavailable, continuing without it:',
            error instanceof APIError ? `${error.status} ${error.message}` : error
          )
          return undefined
        }),
      getMdxContent(),
    ])

    if (moderationResult?.flagged) {
      throw new UserError('Flagged content', {
        flagged: true,
        categories: moderationResult.categories,
      })
    }

    const prompt = codeBlock`
      ${oneLine`
      You are a very enthusiastic employment agent that represents David Yoon. 
      You love to represent David Yoon in the most amazing way possible! 
      Given the following information about David Yoon included in this prompt, answer the question the best way possible.
      The answer should contain empty lines between sentences for readability.
      If you are unsure and the answer is difficult to derive from the information below, say "Sorry, I am unsure of your question, feel free to reach out to David directly."

      ${mdxContent}
      `}

      Question: """
      ${sanitizedQuery}
      """
    `

    // This is the call that can fail on rate limits or quota. Make it before
    // committing headers so a 429 reaches the client as a 429.
    const stream = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      ...modelParams(MODEL),
      stream: true,
    })

    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // Disable nginx buffering
    streaming = true

    // Stream the response in the format expected by the ai package's
    // useCompletion hook: `0:"text chunk"\n` for each chunk.
    try {
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || ''
        if (content) {
          res.write(streamPart(0, content))
          // Flush immediately to prevent timeout
          if (typeof (res as any).flush === 'function') {
            ;(res as any).flush()
          }
        }
      }
    } catch (streamError) {
      // The connection to OpenAI dropped mid-answer. Headers are already out,
      // so report it as an error part rather than a status code.
      console.error('Stream interrupted:', streamError)
      res.write(streamPart(3, 'The answer was cut off. Please try again.'))
    } finally {
      res.end()
    }
  } catch (err: unknown) {
    if (err instanceof UserError) {
      console.error(`${err.message}: ${JSON.stringify(err.data)}`)
    } else if (isRateLimit(err)) {
      console.error(
        `OpenAI rate limit (request ${err.requestID ?? 'unknown'}): ${err.message}`
      )
    } else if (err instanceof APIError && err.status === 400) {
      // Almost always OPENAI_MODEL naming a model that rejects one of the
      // parameters sent above, so say which model was tried. Without this the
      // failure reads as a generic 500 and the env var looks innocent.
      console.error(
        `OpenAI rejected the request for model "${MODEL}" (request ${
          err.requestID ?? 'unknown'
        }): ${err.message}`
      )
    } else if (err instanceof ApplicationError) {
      // Print out application errors with their additional data
      console.error(`${err.message}: ${JSON.stringify(err.data)}`)
    } else {
      // Print out unexpected errors as is to help with debugging
      console.error(err)
    }

    // Once the response is committed we can't change the status code, so the
    // error has to travel as a stream part.
    if (streaming || res.writableEnded || res.headersSent) {
      if (!res.writableEnded) {
        res.write(streamPart(3, 'There was an error processing your request'))
        res.end()
      }
      return
    }

    if (err instanceof UserError) {
      return res.status(400).json({
        error: err.message,
        data: err.data,
      })
    }

    if (isRateLimit(err)) {
      const retryAfter = err.headers?.get('retry-after')
      if (retryAfter) {
        res.setHeader('Retry-After', retryAfter)
      }
      return res.status(429).json({
        error:
          'The assistant is temporarily rate limited by OpenAI. Please try again in a moment.',
      })
    }

    return res.status(500).json({
      error: 'There was an error processing your request',
    })
  }
}
