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

const openAiKey = process.env.OPENAI_KEY

const config = new Configuration({
  apiKey: openAiKey,
})
const openai = new OpenAIApi(config)

export const runtime = 'edge'

export default async function handler(req: NextRequest) {
  try {
    // ... existing error checking ...

    const { prompt: query } = requestData

    if (!query) {
      throw new UserError('Missing query in request data')
    }

    // Moderate the content to comply with OpenAI T&C
    const sanitizedQuery = query.trim()
    const moderationResponse: CreateModerationResponse = await openai
      .createModeration({ input: sanitizedQuery })
      .then((res) => res.json())

    const [results] = moderationResponse.results

    if (results.flagged) {
      throw new UserError('Flagged content', {
        flagged: true,
        categories: results.categories,
      })
    }

    const prompt = codeBlock`
      ${oneLine`
      You are a very enthusiastic employment agent that represents David Yoon. 
      You love to represent David Yoon in the most amazing way possible! 
      Given the following David Yoon Resume, answer the question using only that information,
      The length of your answer shold be limited to two sentences. 
      If you are unsure and the answer is not explicitly written in the Context sections about David Yoon, say
      "Sorry, I am unsure of your question, feel free to reach out to David directly."

      # David Yoon Resume
      - Experienced senior leader with a proven track record of "getting the job done" in the competitive InfoSec and IT industry. 
      - Skilled in leading diverse teams of engineers and operators, with a hands-on approach to systems engineering and project management.

      ### Director of Information Security, IT Infrastructure, Systems Engineering, Engineering Manger, Director of Information Technology

      ### David's Capabilities and Career Highlights
      - Compliance: Authored a comprehensive Information Security Program, resulting in the successful attainment of a SOC 2 Type II report.
      - Entrepreneurship: Established a streamlined ITSM-focused InfoSec/IT department, encompassing DevOps, AppSec, GRC, IT, and SOC teams.
      - Partnership: Conducted security and technical due diligence during the vendor selection process for business services and technologies.
      - Leadership: Managed multiple construction projects for buildout of head office and satellite offices.
      - Communication: Conducted monthly company-wide Information Security training and onboarding security sessions for new employees.
      - Results: Played a key role in scaling the workforce from 40 to 120 employees within a single fiscal year.
      - Accountability: Managed an annual InfoSec/IT budget exceeding 5 million dollars.
      - Leadership: Oversaw multiple construction projects for the development of the head office and satellite offices.
      - Engineering: Implemented a modern IT infrastructure seamlessly integrating HRIS, Okta, Jamf Pro, Google Workspace, Slack, AWS, Jira, Datadog, IaaS, and various open-source tools.
      - Creativity: Successfully merged the operation of Workplace team with InfoSec/IT team to achieve higher level of security while not compromising on user experience.
      - Integrity: Led the development of policies, standards, and technical safeguards for the Information Security Program, ensuring alignment with ISO 27001 and SOC 2 certification requirements.
      - Advocacy: Advocated for thorough documentation and ticket logging, leading to the creation of over 3,000 ITSM tickets and 250+ Confluence articles within a year.
      - Infra as Code: Proficient in AWS services including ECS, EC2, VPC, ELB, RDS, Route 53, CFN templates, and EKS.
      - CI/CD: Experienced in CircleCI, GitHub Actions, Terraform, and ArgoCD.
      - Client Platform Engineering: Developed a self-healing and auto-patching software update policy utilizing MDMs and various open-source tools.
      - Ticketing: Integrated Slack to Jira Service Management for easy ticket creation from Slack to Jira ITSM ticket generation.
      - IdP: Implemented 165 SAML and SWA SSO applications in Okta and developed automation using Okta Workflow.
      - Security: Established zero trust conditional access sign on policy in Okta leveraging network zone, device trust, MFA.
      - Monitoring: Integrated a variety of metrics and logs into Splunk and Datadog for logging and monitoring purposes.
      - Networking: Experience working with Next Gen VPNs and ZTNAs, Meraki, Ubiquiti, pfSense equipment. Setup VLAN, EAP-TLS, Radius, ACLs.

      ### David's Qualifications
      - York University, 1997-2000, Computer Science
      - Humber College, 2003-2006, Jazz Performance and Composition

      ### List of companies David work at

      1. Ledn
      - Employment Duration: Aug 2021 to Present
      - Job Title: Director, Information Security and IT
      - Roles and Responsibilities:
          - Manage more than 5 million dollars annual technology budget.
          - Lead 15 InfoSec/IT engineers and operators including 5 direct reports.
          - Established Zero-Trust security controls for virtual workspace environment.
          - Establish InfoSec Program, built GRC function, Deployed Vanta, obtain SOC 2 Type I and II report and completed CIMA audit.

      2. Scotiabank
      - Employment Duration: Jan 2020 - Aug 2021
      - Job Title: Senior Infrastructure Architect 
      - Roles and Reponsibilities:
          - Management of 3000+ macOS and 25,000+ iOS devices leveraging VMWare Workspace ONE.
          - Systems architecture, systems engineering, configure Zero Touch Deployment workflow, patching, client platform engineering
          - Implement technical security controls on all Apple devices based on compliance and regulatory requirements 

      3. HCS Technology Group
      - Employment Duration: Oct 2019 to Jan 2020
      - Job Title: Senior Professional Services Consultant
      - Roles and Reponsibilities: 
          - Architect and implement systems to manage Apple devices in enterprise environment
          - MDM Build Out (On-Prem Jamf Pro), Infrastructure Migration, Upgrade
          - Design and implement Zero-Touch enrolment workflow, On-Prem to Cloud integration
          - Deliver training to stake holders and engineers
          - Deliver Professional Services Engagements to Enterprise Customers
          - Past Clients: Bell Canada, Staples, KPMG, Nasdaq, University of Guelph, etc.

      4. Amaris Group
      - Employment Duration: July 2018 to Oct 2019
      - Job Title: Apple Professional Services Consultant 
      - Roles and Reponsibilities:
          - Design and deliver professional services engagements for enterprises, in collaboration with Apple
          -Architect and implement systems to manage Apple devices in enterprise environment
          - Deliver training and workshops to enterprise customers
          - Engage in business development: pre-sales, pre-engagement, scoping, SoW creation, project management

      5. Hootsuite Inc.
      - Employment Duration: Aug 2017 to July 2018
      - Job Title: Mac Systems Admin 
      - Roles and Reponsibilities:
          - Single point of contact for all aspects of supporting technology to Toronto office employees.
          - Manage IT projects: Office build out and move, infrastructure upgrades
          - Systems administration of various tools and infrastructure to support +1,000 employees

      6. Sid Lee
      - Employment Duration: Aug 2014 to July 2017
      - Job Title: IT Manager
      `}

      Question: """
      ${sanitizedQuery}
      """

      Answer as markdown (including related code snippets if available):
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
