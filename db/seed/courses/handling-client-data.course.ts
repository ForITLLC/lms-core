import type { CourseSeed } from "@/db/seed/course-seed";

const course: CourseSeed = {
  slug: "handling-client-data",
  title: "Handling Client Data",
  description:
    "Keep client data in the right places, out of the wrong ones, and know exactly what to do when something goes sideways.",
  category: "security",
  mandatory: true,
  scheduleKind: "annual",
  tags: ["security", "privacy", "client-data", "compliance", "annual"],
  lessons: [
    {
      title: "What Counts as Client Data",
      estMinutes: 5,
      blocks: [
        {
          kind: "text",
          markdown:
            "## The working definition\n\n**Client data is anything that came from a customer's tenant, or anything you produced while working for them.** That second half is the part people miss. The architecture diagram you drew this morning is client data. The screenshot you pasted into a chat to explain the problem is client data. The list of mailboxes you exported to a CSV \"just to look at\" is client data.\n\nIf it would not exist without the engagement, it belongs to the engagement.",
        },
        {
          kind: "text",
          markdown:
            "## The four buckets\n\nMost client data falls into one of these. All four are sensitive — they just leak in different ways.\n\n| Bucket | Examples |\n|---|---|\n| **PII** | Names, work and personal emails, phone numbers, addresses, government IDs, dates of birth |\n| **Business confidential** | Contracts, pricing, financial statements, payroll, employee records, board materials, M&A plans |\n| **Technical** | Tenant IDs, network diagrams, system configurations, secrets, source code, infrastructure inventory |\n| **Metadata about the data** | The fact that Client A uses Product X, that Client B is migrating off Y, that Client C had an incident last month |",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**Metadata is data.** \"We can't say who, but one of our clients in healthcare just had a ransomware incident\" is still a leak. The set of facts you know about a customer is itself confidential.",
        },
        {
          kind: "text",
          markdown:
            "## Multi-tenant makes it multiplicative\n\n{{company_name}} works for many customers in parallel. Every customer is its own boundary — their data does not mix with another customer's data, and it does not mix with {{company_name}}'s internal data either.\n\nThat means three rules at once:\n\n- Client A's stuff does not touch Client B's tenant, vault, repo, or channel.\n- Client A's stuff does not get reused in a deliverable for Client B.\n- Client A's stuff does not sit in {{company_name}}'s general-purpose spaces (a company-wide Teams channel, a shared OneNote, a personal OneDrive) where it isn't scoped to the engagement.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "If you can't immediately answer **\"which customer does this belong to and where is it allowed to live?\"** about a file you're holding, stop and figure that out before you do anything else with it.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "multi",
            promptMd:
              "Which of these are client data? Select all that apply.",
            choices: [
              {
                id: "a",
                label:
                  "A CSV of user mailboxes you exported from the customer's tenant",
              },
              {
                id: "b",
                label:
                  "A network diagram you drew yourself based on the engagement",
              },
              {
                id: "c",
                label:
                  "The fact that the customer is migrating off a particular product",
              },
              {
                id: "d",
                label: "A public press release the customer posted last week",
              },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "tf",
            promptMd:
              "Saying \"one of our clients in healthcare just had a ransomware incident\" is fine because you didn't name them.",
            correctValue: false,
          },
          {
            kind: "mcq",
            promptMd:
              "You're juggling work for three customers this week. What does \"multi-tenant\" responsibility actually require?",
            choices: [
              {
                id: "a",
                label:
                  "Each customer's data stays scoped to that engagement and never mixes with another customer's or with {{company_name}}'s general spaces",
              },
              {
                id: "b",
                label:
                  "It's fine to mix customers in one shared workspace as long as everyone on the team has signed an NDA",
              },
              {
                id: "c",
                label:
                  "You only need to worry about isolation for the largest customer of the three",
              },
              {
                id: "d",
                label:
                  "Customer data is fine to combine once the project is past the kickoff stage",
              },
            ],
            correctChoiceId: "a",
          },
        ],
      },
    },
    {
      title: "Where Data Is Allowed to Live",
      estMinutes: 6,
      blocks: [
        {
          kind: "text",
          markdown:
            "## The green list\n\nThese are the only places client data is allowed to sit. Anywhere else is by exception.\n\n- **The customer's own M365 tenant** — their SharePoint, their OneDrive, their Teams, their mailboxes. Always the first choice for documents that are theirs.\n- **{{company_name}}'s Microsoft 365 tenant**, in a workspace scoped to that engagement — a Teams team for the project, a SharePoint site for deliverables, a mailbox for inbound.\n- **A business password manager such as 1Password Business**, in a vault shared only with the people on that engagement. Secrets and credentials live here, never in a doc or a chat.\n- **Source control such as GitHub**, for source code {{company_name}} owns or co-owns under the engagement.\n- **A cloud platform such as Azure**, for services {{company_name}} hosts for that customer, configured in their own subscription or resource group.",
        },
        {
          kind: "text",
          markdown:
            "## The red list\n\nThese all feel convenient. They are all leaks waiting to happen.\n\n- **Personal Slack, Teams, Discord, iMessage, SMS, WhatsApp DMs.** Personal accounts are not under company governance and have no retention or audit.\n- **Personal email** (Gmail, iCloud, Yahoo) — including \"just forwarding it to myself so I can work on it tonight.\"\n- **Personal cloud drives** — your personal OneDrive, Google Drive, Dropbox, iCloud Drive.\n- **Pastebins** (pastebin.com, gist with default-public, JSFiddle) for sharing logs or configs.\n- **AI tools without enterprise data terms** — ChatGPT free, the public Claude.ai web app, free Gemini, free Copilot. They can train on your inputs.\n- **USB drives and external disks** without disk encryption.\n- **Screenshots in any channel wider than the engagement team** — the #general channel, an all-hands deck, a LinkedIn post.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "**ChatGPT free is not a tool, it is a leak.** Pasting a customer's data into a consumer AI is the same as posting it on a forum. If you need AI for client work, use the enterprise-licensed tool your engagement allows — and confirm it has zero-retention or no-training terms.",
        },
        {
          kind: "text",
          markdown:
            "## The rule of thumb\n\nFor anything you're about to save, send, paste, or upload, ask: **would the customer be fine with it sitting exactly there?** Not \"would they ever find out,\" but \"if they walked through this location with you tomorrow, would they shrug or would they file a complaint?\"\n\nIf the answer is anything other than a clean shrug, that's the wrong place.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**A link beats an attachment.** Linking a file in the customer's SharePoint (or {{company_name}}'s engagement workspace) keeps a single source of truth, preserves audit, and avoids copies multiplying across mailboxes and laptops. Reach for the share link before the paperclip.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "multi",
            promptMd:
              "Which of these are acceptable places for client data to live? Select all that apply.",
            choices: [
              {
                id: "a",
                label: "The customer's own SharePoint and OneDrive",
              },
              {
                id: "b",
                label:
                  "An engagement-scoped Teams team in {{company_name}}'s Microsoft 365 tenant",
              },
              {
                id: "c",
                label:
                  "A 1Password Business vault shared with the engagement team",
              },
              {
                id: "d",
                label: "Your personal Gmail, for finishing work at home",
              },
              {
                id: "e",
                label:
                  "A USB drive you carry between machines, unencrypted",
              },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "mcq",
            promptMd:
              "You need an AI to summarize a long customer document. What's the right move?",
            choices: [
              {
                id: "a",
                label:
                  "Paste it into ChatGPT free — it'll be quicker than reading it",
              },
              {
                id: "b",
                label:
                  "Use an enterprise-licensed AI tool the engagement permits, with zero-retention or no-training terms confirmed",
              },
              {
                id: "c",
                label:
                  "Email the doc to your personal Gmail so you can use any AI you want at home",
              },
              {
                id: "d",
                label:
                  "Post the doc into a public pastebin and ask an AI to fetch it",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "Sharing a SharePoint link to a file is generally preferable to attaching a copy of the file in email.",
            correctValue: true,
          },
          {
            kind: "confidence",
            promptMd:
              "You're about to drop a customer's config file into a #general company channel so a teammate can grab it. What should you do?",
            choices: [
              {
                id: "a",
                label:
                  "Put it in the engagement-scoped Teams or SharePoint and DM the teammate the link — #general is too wide for client data",
              },
              {
                id: "b",
                label:
                  "Post it in #general — everyone at {{company_name}} has signed an NDA so it's fine",
              },
              {
                id: "c",
                label:
                  "Email it from your personal account so it doesn't clutter the channel",
              },
              {
                id: "d",
                label:
                  "Upload it to a public pastebin and share the link in #general",
              },
            ],
            correctChoiceId: "a",
          },
        ],
      },
    },
    {
      title: "NDAs and Cross-Client Boundaries",
      estMinutes: 5,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Work product doesn't travel by default\n\nA spec you wrote for Client A, a Terraform module you built for Client A, a runbook you put together for Client A — those aren't generic {{company_name}} assets. They're work product produced under that engagement, and they belong to that engagement.\n\nReusing them for Client B feels harmless because you wrote them. It isn't. You may be redelivering content the contract says belongs to Client A. You may be revealing how Client A solved a problem — sometimes a competitive advantage they paid you to build. And you may be importing Client A's mistakes into Client B's environment without context.\n\n**If you want to reuse it, get explicit written OK from Client A first**, or extract a genuinely generic version (no names, no specifics, no embedded config) and confirm with your engagement lead that it's clean.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**Templates and patterns:** the abstraction is fine. \"Here's how we typically structure a tenant migration runbook\" is reusable knowledge. \"Here's Client A's tenant migration runbook with the names changed\" is not.",
        },
        {
          kind: "text",
          markdown:
            "## Don't talk about Client A with Client B\n\nNot even casually. Not as a war story, not as a reference point, not as \"another customer we work with had a similar issue.\" A customer in the room with you should never learn anything about another customer — not their name, not their stack, not their problem, not the fact that they exist on your roster.\n\nThis matters more than people think because customers are paying for your attention and your discretion. Hearing you swap stories about another client tells them exactly how their information will be treated when they're not in the room.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**The conference-talk test.** Before mentioning a customer's situation to anyone outside that engagement, ask: *would this be a story I could tell at a conference, with that customer's written permission?* If yes, you can probably share the abstract pattern. If no — or you'd need to leave names and specifics out to make it safe — keep it private.",
        },
        {
          kind: "text",
          markdown:
            "## NDA hygiene in practice\n\n- **Know which NDA you're under for each engagement.** Mutual? One-way? Time-limited? Some customers have unusual carve-outs.\n- **Default to discretion.** When in doubt, treat something as covered. It's almost never wrong to say less.\n- **Be careful with screen sharing.** Close other customers' tabs, mute notifications, and check your dock and browser history before you share. Visible tab titles count as a disclosure.\n- **Be careful in public.** Coffee shops, airports, planes — assume the person next to you is reading your screen and listening to your call. They usually are.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "You wrote a great runbook for Client A and a similar problem just came up at Client B. What's the right move?",
            choices: [
              {
                id: "a",
                label:
                  "Copy it over to Client B with the names changed — the work is yours, you wrote it",
              },
              {
                id: "b",
                label:
                  "Get explicit written OK from Client A to reuse it, or extract a genuinely generic version (no names, no specifics) and confirm with your engagement lead",
              },
              {
                id: "c",
                label:
                  "Send Client B the original runbook so they can see real-world context",
              },
              {
                id: "d",
                label:
                  "Post the runbook in #general so anyone working with similar customers can grab it",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "It's fine to mention to Client B that you also work with Client A, as long as you don't share any specifics.",
            correctValue: false,
          },
          {
            kind: "multi",
            promptMd:
              "Which of these are good NDA hygiene before a screen share with a customer? Select all that apply.",
            choices: [
              {
                id: "a",
                label: "Close tabs for other customers' tenants and tools",
              },
              {
                id: "b",
                label: "Mute notifications so other customers' chats don't pop up",
              },
              {
                id: "c",
                label:
                  "Check your dock, browser history, and recent files for anything visible",
              },
              {
                id: "d",
                label:
                  "Take the call from a busy coffee shop because it's a comfortable spot",
              },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
        ],
      },
    },
    {
      title: "End of Engagement and Data Lifecycle",
      estMinutes: 5,
      blocks: [
        {
          kind: "text",
          markdown:
            "## The contract tells you what to do\n\nEvery engagement ends. When it does, your contract — usually the MSA or the SOW — spells out what happens to the data. The two common shapes are:\n\n- **Return or destroy on request.** The customer asks for their data back (or for proof of destruction), and you have a window — often 30 to 60 days — to deliver.\n- **Destroy on termination.** Your obligation kicks in automatically when the engagement ends, with no request needed.\n\nRead the clause for the engagement you're closing out. If you can't find it or aren't sure, ask your engagement lead — don't guess.",
        },
        {
          kind: "text",
          markdown:
            "## What \"clean up\" actually means\n\nNot just one place. All of them.\n\n- **Your laptop and devices.** Delete local copies, empty the trash, clear any Downloads folder, and check for cached copies in editor workspaces or AI chat histories.\n- **Your password manager (such as 1Password).** Remove or archive the engagement vault. Rotate any shared credentials that may have been used elsewhere.\n- **GitHub.** Archive repos per contract. Remove your access if the customer owns the org. If {{company_name}} owns the code, confirm whether the customer keeps a license to it.\n- **M365 ({{company_name}} side).** Apply the retention label the policy requires. Some content is kept (for legal or accounting reasons); some is deleted. Follow the label — don't freelance.\n- **M365 (customer side).** If you had guest access to their tenant, ask them to remove it, or remove it yourself if you can.\n- **Anywhere else.** Personal notes apps, sticky notes, scratch files. Yes, really.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "**Retention is not a virtue.** Keeping more data than the contract requires isn't being thorough — it's expanding your blast radius. If you're breached two years from now, every old engagement still sitting on your laptop becomes part of the breach.",
        },
        {
          kind: "text",
          markdown:
            "## During the engagement, too\n\nThe end of an engagement isn't the only time to clean up. Data has a lifecycle while the work is live:\n\n- **Don't pull more than you need.** If you only need ten user records to validate a script, don't export all fifty thousand.\n- **Delete intermediates once you're done with them.** The big debug log, the test CSV, the scratch file from yesterday. Today's convenience is next year's exposure.\n- **Keep the source of truth in the customer's tenant** where possible, so the lifecycle is theirs to manage and your copies are minimal.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**A small data set is a small breach.** Pull the minimum you need to do the job, and delete it the moment the job is done. The goal isn't perfect hygiene forever — it's keeping the pile small.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "An engagement ends and the contract requires destruction of customer data. What's your job?",
            choices: [
              {
                id: "a",
                label:
                  "Delete the obvious shared folder and consider it done",
              },
              {
                id: "b",
                label:
                  "Clean up every location the data touched — local devices, 1Password, GitHub, M365 retention labels, guest access — per the contract and policy",
              },
              {
                id: "c",
                label:
                  "Keep everything — you might need it for a future engagement",
              },
              {
                id: "d",
                label:
                  "Archive the data to a personal cloud drive in case the customer comes back",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "Keeping extra customer data \"just in case\" is harmless — at worst it's wasted disk space.",
            correctValue: false,
          },
          {
            kind: "mcq",
            promptMd:
              "You need to test a script against the customer's user directory. You only need about ten records to validate it. What's the right approach?",
            choices: [
              {
                id: "a",
                label: "Export the entire directory so you have it for next time",
              },
              {
                id: "b",
                label:
                  "Pull only the ten records you need, work with that subset, and delete it when the script is validated",
              },
              {
                id: "c",
                label:
                  "Export everything and stash it on a personal drive in case the customer asks again later",
              },
              {
                id: "d",
                label:
                  "Skip testing and run the script live in production instead",
              },
            ],
            correctChoiceId: "b",
          },
        ],
      },
    },
    {
      title: "If You Mess Up",
      estMinutes: 3,
      blocks: [
        {
          kind: "text",
          markdown:
            "## The realistic scenarios\n\nThese are the ones that actually happen, not the dramatic ones from a security awareness poster.\n\n- You pasted a customer's data into ChatGPT free to summarize a doc faster.\n- You attached the wrong file in an email — Client A's pricing went to Client B.\n- You DM'd a customer document to someone who shouldn't have it.\n- You pushed a config to a public GitHub repo with a real API key in it.\n- You lost a laptop, phone, or USB drive that had client data on it.\n\nNone of these mean you're a bad employee. All of them mean the clock is now running.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "**Speed limits damage. Hiding turns a near-miss into a breach.** A pasted prompt reported in the first ten minutes can sometimes be revoked or expired. A leaked credential rotated immediately may never have been used. The actions that contain incidents are all things only humans can start.",
        },
        {
          kind: "text",
          markdown:
            "## What to do, right now\n\n1. **Tell {{company_name}} IT or your manager immediately.** Use Teams, email ({{support_email}}), phone — whichever reaches a human fastest. Don't draft the perfect message; a one-liner is fine.\n2. **Don't delete the evidence.** Leave the wrong-recipient email, the suspicious file, the chat log. The team needs to see what happened to size the response.\n3. **Don't try to retract it yourself in a way that creates more exposure.** Don't email Client B saying \"please ignore that, here's the real one with Client A's data, sorry\" — that just resends the data.\n4. **Write down what you remember.** Time, what you sent, where, to whom. Memory degrades fast under stress.\n\nThe full incident response process is its own course. For now: report, preserve, don't compound.",
        },
        {
          kind: "callout",
          variant: "success",
          markdown:
            "**You are not in trouble for reporting.** You may be in trouble for hiding. Every security team in the world would rather hear about ten small mistakes early than discover one big one late.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "confidence",
            promptMd:
              "You just realized you pasted a chunk of a customer's document into ChatGPT free. What do you do?",
            choices: [
              {
                id: "a",
                label:
                  "Report it to {{company_name}} IT or your manager immediately — speed is what limits the damage",
              },
              {
                id: "b",
                label:
                  "Quietly delete your chat history and hope nothing was retained",
              },
              {
                id: "c",
                label:
                  "Wait a few days to see if anything bad happens before mentioning it",
              },
              {
                id: "d",
                label:
                  "Tell nobody — you'll just be careful next time and that's enough",
              },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "You sent Client A's pricing spreadsheet to a contact at Client B by mistake. What's the right immediate move?",
            choices: [
              {
                id: "a",
                label:
                  "Email Client B with the corrected file attached and apologize — that resends the data",
              },
              {
                id: "b",
                label:
                  "Delete the sent email from your Sent folder so there's no record",
              },
              {
                id: "c",
                label:
                  "Report it to {{company_name}} IT or your manager immediately, preserve the email, and let them coordinate the response",
              },
              {
                id: "d",
                label:
                  "Wait to see if Client B notices or replies before doing anything",
              },
            ],
            correctChoiceId: "c",
          },
          {
            kind: "tf",
            promptMd:
              "Reporting a mistake quickly is far more important than reporting it perfectly worded.",
            correctValue: true,
          },
        ],
      },
    },
  ],
};

export default course;
