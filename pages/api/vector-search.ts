import type { NextApiRequest, NextApiResponse } from 'next'
import { codeBlock, oneLine } from 'common-tags'
import OpenAI from 'openai'
import { ApplicationError, UserError } from '@/lib/errors'
import { readMdxFiles } from '@/lib/read-mdx-files'

const openAiKey = process.env.OPENAI_KEY

const openai = new OpenAI({
  apiKey: openAiKey,
})

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Parse request body - Next.js automatically parses JSON body for us
    const { prompt: query } = req.body

    if (!query) {
      throw new UserError('Missing query in request data')
    }

    const sanitizedQuery = query.trim()

    // Set headers for streaming response early to prevent timeout
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // Disable nginx buffering

    // Start response immediately to prevent timeout
    res.write('')

    // Run moderation and MDX reading in parallel for faster startup
    const [moderationResponse, mdxContent] = await Promise.all([
      openai.moderations.create({
        input: sanitizedQuery,
      }),
      readMdxFiles().catch((error) => {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to load MDX files:', errorMessage)
        throw new ApplicationError(
          'Failed to load knowledge base content. Please try again later.',
          { originalError: errorMessage }
        )
      }),
    ])

    if (!moderationResponse.results || !Array.isArray(moderationResponse.results) || moderationResponse.results.length === 0) {
      throw new ApplicationError('Invalid moderation response', { moderationResponse })
    }

    const [results] = moderationResponse.results

    if (results && results.flagged) {
      throw new UserError('Flagged content', {
        flagged: true,
        categories: results.categories,
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

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: 512,
      temperature: 0,
      stream: true,
    })

    // Stream the response in the format expected by the ai package's useCompletion hook
    // The format is: 0:"text chunk"\n for each chunk
    try {
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || ''
        if (content) {
          // Format as data stream: 0:"content"\n
          // Escape quotes and newlines properly
          const escapedContent = content
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
          res.write(`0:"${escapedContent}"\n`)
          // Flush immediately to prevent timeout
          if (typeof (res as any).flush === 'function') {
            (res as any).flush()
          }
        }
      }
    } finally {
      res.end()
    }
  } catch (err: unknown) {
    if (err instanceof UserError) {
      return res.status(400).json({
        error: err.message,
        data: err.data,
      })
    } else if (err instanceof ApplicationError) {
      // Print out application errors with their additional data
      console.error(`${err.message}: ${JSON.stringify(err.data)}`)
    } else {
      // Print out unexpected errors as is to help with debugging
      console.error(err)
    }

    return res.status(500).json({
      error: 'There was an error processing your request',
    })
  }
}
