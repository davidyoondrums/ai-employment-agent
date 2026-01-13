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
 */
export async function readMdxFiles(): Promise<string> {
  const docsDir = join(process.cwd(), 'pages', 'docs')
  const files = ['DavidYoonResume.mdx', 'KnowledgeCollection.mdx']
  
  const contents: string[] = []
  
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
      
      if (mdTree) {
        const text = toString(mdTree)
        contents.push(`\n# ${file.replace('.mdx', '')}\n\n${text}\n`)
      }
    } catch (error) {
      console.error(`Error reading ${file}:`, error)
    }
  }
  
  return contents.join('\n---\n')
}
