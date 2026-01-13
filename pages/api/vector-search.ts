import { NextRequest } from 'next/server'
import { codeBlock, oneLine } from 'common-tags'
import {
  Configuration,
  OpenAIApi,
  CreateModerationResponse,
  ChatCompletionRequestMessage,
} from 'openai-edge'
import { OpenAIStream, StreamingTextResponse } from 'ai'
import { ApplicationError, UserError } from '@/lib/errors'
import { readMdxFiles } from '@/lib/read-mdx-files'

const openAiKey = process.env.OPENAI_KEY

const config = new Configuration({
  apiKey: openAiKey,
})
const openai = new OpenAIApi(config)

// Change to nodejs runtime to allow file system access
export const runtime = 'nodejs'

export default async function handler(req: NextRequest) {
  try {
    // Parse request body - handle both edge and nodejs runtime
    let requestData: { prompt?: string }
    
    try {
      // In Next.js 13, NextRequest.json() should work, but if it doesn't, use body reader
      if (req.json && typeof req.json === 'function') {
        requestData = await req.json()
      } else if (req.body && typeof req.body.getReader === 'function') {
        // Fallback: read from body stream for nodejs runtime
        const reader = req.body.getReader()
        const chunks: Uint8Array[] = []
        let done = false
        
        while (!done) {
          const { value, done: streamDone } = await reader.read()
          done = streamDone
          if (value) {
            chunks.push(value)
          }
        }
        
        // Concatenate all chunks
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const combined = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
          combined.set(chunk, offset)
          offset += chunk.length
        }
        const bodyText = new TextDecoder().decode(combined)
        requestData = JSON.parse(bodyText)
      } else {
        throw new UserError('Request body is not available')
      }
    } catch (parseError) {
      console.error('Error parsing request body:', parseError)
      throw new UserError('Invalid request body format')
    }
    
    const { prompt: query } = requestData

    if (!query) {
      throw new UserError('Missing query in request data')
    }

    // Moderate the content to comply with OpenAI T&C
    const sanitizedQuery = query.trim()
    const moderationResponse: CreateModerationResponse = await openai
      .createModeration({ input: sanitizedQuery })
      .then((res) => res.json())

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

    // Read MDX files directly
    let mdxContent: string
    try {
      mdxContent = await readMdxFiles()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.error('Failed to load MDX files:', errorMessage)
      throw new ApplicationError(
        'Failed to load knowledge base content. Please try again later.',
        { originalError: errorMessage }
      )
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

    const chatMessage: ChatCompletionRequestMessage = {
      role: 'user',
      content: prompt,
    }

    const response = await openai.createChatCompletion({
      model: 'gpt-4o',
      messages: [chatMessage],
      max_tokens: 512,
      temperature: 0,
      stream: true,
    })

    if (!response.ok) {
      const error = await response.json()
      throw new ApplicationError('Failed to generate completion', error)
    }

    // Transform the response into a readable stream
    const stream = OpenAIStream(response)

    // Return a StreamingTextResponse, which can be consumed by the client
    return new StreamingTextResponse(stream)
  } catch (err: unknown) {
    if (err instanceof UserError) {
      return new Response(
        JSON.stringify({
          error: err.message,
          data: err.data,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    } else if (err instanceof ApplicationError) {
      // Print out application errors with their additional data
      console.error(`${err.message}: ${JSON.stringify(err.data)}`)
    } else {
      // Print out unexpected errors as is to help with debugging
      console.error(err)
    }

    // TODO: include more response info in debug environments
    return new Response(
      JSON.stringify({
        error: 'There was an error processing your request',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
