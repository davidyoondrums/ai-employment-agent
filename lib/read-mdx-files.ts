import { readFile } from 'fs/promises'
import { join } from 'path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { mdxjs } from 'micromark-extension-mdxjs'
import { mdxFromMarkdown } from 'mdast-util-mdx'
import { toString } from 'mdast-util-to-string'
import { filter } from 'unist-util-filter'

/**
 * Reads and processes MDX files to extract plain text content
 * Removes JSX/MDX syntax and returns clean text
 * @throws Error if any required MDX files cannot be read or processed
 */
export async function readMdxFiles(): Promise<string> {
  const docsDir = join(process.cwd(), 'pages', 'docs')
  const files = ['DavidYoonResume.mdx', 'KnowledgeCollection.mdx']
  
  const contents: string[] = []
  const errors: string[] = []
  
  for (const file of files) {
    try {
      const filePath = join(docsDir, file)
      const content = await readFile(filePath, 'utf8')
      
      // Parse MDX and extract text
      const mdxTree = fromMarkdown(content, {
        extensions: [mdxjs()],
        mdastExtensions: [mdxFromMarkdown()],
      })
      
      // Remove all MDX/JSX elements
      const mdTree = filter(
        mdxTree,
        (node) =>
          ![
            'mdxjsEsm',
            'mdxJsxFlowElement',
            'mdxJsxTextElement',
            'mdxFlowExpression',
            'mdxTextExpression',
          ].includes(node.type)
      )
      
      if (!mdTree) {
        throw new Error(`Failed to parse MDX tree for ${file}`)
      }
      
      const text = toString(mdTree)
      if (!text || text.trim().length === 0) {
        throw new Error(`No content extracted from ${file}`)
      }
      
      contents.push(`\n# ${file.replace('.mdx', '')}\n\n${text}\n`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      errors.push(`Failed to read ${file}: ${errorMessage}`)
      console.error(`Error reading ${file}:`, error)
    }
  }
  
  // Fail if no files were successfully read
  if (contents.length === 0) {
    throw new Error(
      `Failed to read any MDX files. Errors: ${errors.join('; ')}`
    )
  }
  
  // Warn if some files failed but continue with available content
  if (errors.length > 0) {
    console.warn(
      `Warning: Some MDX files failed to load. Successfully loaded ${contents.length}/${files.length} files. Errors: ${errors.join('; ')}`
    )
  }
  
  const result = contents.join('\n---\n')
  
  // Ensure we have meaningful content
  if (!result || result.trim().length === 0) {
    throw new Error('No content extracted from MDX files')
  }
  
  return result
}
