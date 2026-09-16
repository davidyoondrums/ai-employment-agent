import * as React from 'react'

type UseCompletionOptions = {
  /** API route that streams the completion. */
  api: string
}

/**
 * Minimal replacement for the `ai` package's useCompletion.
 *
 * The API route hand-writes the wire format, so both sides are ours: each part
 * is `<code>:<json value>\n`, where code 0 is a text delta and code 3 is an
 * error. That is all this app needs, and it avoids depending on a multi-
 * framework SDK for a single hook.
 */
export function useCompletion({ api }: UseCompletionOptions) {
  const [completion, setCompletion] = React.useState('')
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<Error | undefined>(undefined)

  const abortRef = React.useRef<AbortController | null>(null)

  // Abandon an in-flight request if the component goes away.
  React.useEffect(() => () => abortRef.current?.abort(), [])

  const complete = React.useCallback(
    async (prompt: string) => {
      // A second question supersedes whatever is still streaming.
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setCompletion('')
      setError(undefined)
      setIsLoading(true)

      try {
        const response = await fetch(api, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw new Error(body?.error ?? `Request failed with status ${response.status}`)
        }

        if (!response.body) {
          throw new Error('The server returned an empty response')
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let text = ''

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // Parts are newline-delimited. A chunk can split one, so hold the
          // trailing fragment back until the rest of it arrives.
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line) continue

            const separator = line.indexOf(':')
            if (separator === -1) continue

            const code = line.slice(0, separator)
            let payload: string
            try {
              payload = JSON.parse(line.slice(separator + 1))
            } catch {
              continue // Ignore a part we can't parse rather than dropping the answer.
            }

            if (code === '0') {
              text += payload
              setCompletion(text)
            } else if (code === '3') {
              throw new Error(payload)
            }
          }
        }
      } catch (err) {
        // An abort is a supersede or an unmount, not a failure to report.
        if (err instanceof Error && err.name === 'AbortError') return
        setError(err instanceof Error ? err : new Error(String(err)))
      } finally {
        setIsLoading(false)
      }
    },
    [api]
  )

  return { complete, completion, isLoading, error }
}
