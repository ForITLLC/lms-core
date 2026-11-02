import type { CourseSeed } from "@/db/seed/course-seed";

const course: CourseSeed = {
  slug: "ai-at-work",
  title: "AI at Work — Claude & ChatGPT",
  description:
    "Get real leverage out of Claude and ChatGPT without leaking client data.",
  category: "productivity",
  mandatory: true,
  tags: ["productivity", "ai", "claude", "chatgpt", "copilot"],
  lessons: [
    {
      title: "What AI Is Good At, and What It Isn't",
      estMinutes: 5,
      blocks: [
        {
          kind: "text",
          markdown:
            "## The model is a confident intern, not an oracle\n\nClaude and ChatGPT are language models. They predict the next word, very well, against an enormous training corpus. That makes them sharp at anything where **a fluent first draft beats a blank page** — and unreliable at anything where being *almost right* is the same as being wrong.\n\nThe failure mode that gets people in trouble isn't that the model is bad. It's that the model is **confident either way**. A wrong answer comes out in the same calm, professional voice as a right one. There is no facial expression, no hedging, no \"I'm guessing here.\" That's the part you have to supply.",
        },
        {
          kind: "text",
          markdown:
            "## Where it earns its keep\n\nReach for the model when the work is generative, structural, or transformational:\n\n- **Drafting** — emails, proposals, status updates, meeting notes, job descriptions. First drafts in seconds, then you edit.\n- **Summarizing** — a 40-message thread into three bullets, a long PDF into the five things that matter.\n- **Brainstorming** — give it a problem and ask for ten angles. You pick the two worth pursuing.\n- **Rewriting and reformatting** — change tone, tighten length, convert prose to a table, table to prose, bullets to paragraphs.\n- **Code** — boilerplate, refactors, explaining unfamiliar code, writing tests, debugging stack traces.\n- **Translation and explanation** — \"explain this contract clause like I'm not a lawyer,\" \"translate this customer email into Spanish.\"",
        },
        {
          kind: "text",
          markdown:
            "## Where it will quietly burn you\n\nTreat output as a draft, never a citation, in these cases:\n\n- **Specific facts, dates, names, citations.** Models hallucinate sources that don't exist — court cases, papers, URLs, RFC numbers. If a fact has to be true, look it up yourself.\n- **Math beyond simple arithmetic.** Multi-step calculations, percentages of percentages, anything financial. Use a calculator or have it write Python and run that.\n- **Anything time-sensitive past the training cutoff.** Recent pricing, recent policy changes, what shipped last week — the model doesn't know and will guess.\n- **High-stakes judgment without verification.** Legal advice, medical questions, security configurations, contract terms. Useful for a first read; never the final word.\n- **Counting and exact extraction.** Asking how many times X appears in a document, or to list every instance of Y — it will miss some and invent others.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "**Confidence is not correctness.** A model that's wrong sounds exactly like a model that's right. If a wrong answer has consequences, your job is to verify before you ship — not to feel reassured by the smooth prose.",
        },
        {
          kind: "text",
          markdown:
            "## The always-verify-before-you-ship rule\n\nBefore anything the model wrote leaves your hands — sent to a client, committed to a repo, pasted into a contract, posted publicly — read it back as if a junior coworker handed it to you. Specifically check:\n\n1. **The facts.** Names spelled right, numbers plausible, dates real, links open to what they claim.\n2. **The tone.** Does it sound like you, or like a chatbot impersonating you?\n3. **The reasoning.** If it made an argument, does the argument actually hold up — or does it sound convincing without being correct?\n\nIf you can't be bothered to verify, you can't be bothered to send it. Either spend the five minutes, or don't use the output.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**Good question to ask the model itself:** *\"What in this answer might be wrong, and how would I check?\"* It's often surprisingly honest about its own weak spots when you invite it to be.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "Which of these is the **best** use of Claude or ChatGPT for a typical workday task?",
            choices: [
              {
                id: "a",
                label:
                  "Looking up the exact text of a recently passed FAA regulation to quote in a client email",
              },
              {
                id: "b",
                label:
                  "Drafting a first version of a long status update so you can edit it down",
              },
              {
                id: "c",
                label:
                  "Calculating the exact tax owed on a multi-state invoice without a calculator",
              },
              {
                id: "d",
                label:
                  "Asking which competitor signed a deal last week and pasting the answer into a sales report",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "If Claude answers a question in a confident, professional tone with no hedging, that's a reliable signal the answer is correct.",
            correctValue: false,
          },
          {
            kind: "mcq",
            promptMd:
              "You ask the model for three case-law citations to support an argument in a memo. It returns three, complete with case names and reporter numbers. What's the right next step?",
            choices: [
              {
                id: "a",
                label: "Paste them into the memo — the format looks right",
              },
              {
                id: "b",
                label:
                  "Look each citation up in an actual legal database before relying on any of them",
              },
              {
                id: "c",
                label:
                  "Ask the model to confirm the citations are real, and trust the answer",
              },
              {
                id: "d",
                label:
                  "Use them but add a footnote saying \"per AI\" so the reader can decide",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "mcq",
            promptMd:
              "Which task is the model **least** suited for without verification?",
            choices: [
              {
                id: "a",
                label: "Rewriting a paragraph in a more formal tone",
              },
              {
                id: "b",
                label: "Summarizing a 20-page PDF into a one-page brief",
              },
              {
                id: "c",
                label:
                  "Counting how many times a specific phrase appears in a long document",
              },
              {
                id: "d",
                label: "Brainstorming five angles for a marketing campaign",
              },
            ],
            correctChoiceId: "c",
          },
        ],
      },
    },
    {
      title: "Prompts as Briefs",
      estMinutes: 5,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Prompt the model the way you'd brief a new hire\n\nThe difference between a useless answer and a great one is almost never the model — it's the prompt. A one-line prompt gets a one-line-of-thought response. A real brief gets real work back.\n\nA good prompt has five parts. You don't need every one every time, but if your answer disappoints, the missing piece is usually here:\n\n- **Role** — \"You are an experienced aviation maintenance manager…\"\n- **Context** — what the situation is, who it's for, what's already been tried.\n- **Task** — exactly what you want done. One verb.\n- **Format** — bullets, table, email, JSON, length, headings, tone.\n- **Constraints** — what to avoid, what to assume, hard limits.\n\nAn example or two of what *good* looks like is worth more than a paragraph of adjectives.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**Examples beat instructions.** Telling the model \"write it in our voice\" is vague. Pasting two real emails you've sent and asking it to match them is precise. Show, don't tell.",
        },
        {
          kind: "text",
          markdown:
            "## Iterate, don't restart\n\nThe first response is almost never the final one. Treat the chat like a back-and-forth with a coworker, not a vending machine.\n\n- **Refine in place.** \"Tighter. Drop the second bullet. Make the tone less corporate.\" The model keeps the rest of the context.\n- **Add what was missing.** \"I forgot to mention — this is going to a client we just signed, not a long-term one. Redo with that in mind.\"\n- **Ask for variants.** \"Give me three versions: one warm, one neutral, one firm.\"\n- **Steer with the next message, not by starting over.** Every time you open a fresh chat you throw away the context the model has built up.\n\nThe exception: if you've gone far down the wrong path, or the conversation has drifted, **do** start fresh with a better brief. Don't fight a poisoned context.",
        },
        {
          kind: "text",
          markdown:
            "## A short cookbook\n\nPatterns that pay off over and over. Steal them.\n\n- **Tone rewrite** — *\"Rewrite this email to sound friendlier but still firm about the deadline. Keep it under 120 words. Preserve the bullet list.\"*\n- **Extract action items** — *\"From this meeting transcript, list each action item as: owner — task — due date. If a date isn't stated, write 'unspecified.'\"*\n- **Explain like…** — *\"Explain what a SOC 2 audit is to a small-business owner with no security background, in under 200 words, no acronyms without defining them.\"*\n- **Critique my draft** — *\"Here is my proposal. Play the role of a skeptical client. List the three weakest points and what would make each one stronger.\"*\n- **Convert format** — *\"Turn this paragraph into a 3-column table: Risk, Impact, Mitigation.\"*\n- **Pre-meeting prep** — *\"Here are my notes on the account. Draft five questions I should ask in tomorrow's call to surface budget and timeline without being pushy.\"*",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**Claude and ChatGPT are interchangeable for most of this.** Claude tends to be stronger at long-form writing and careful reasoning; ChatGPT is fine for the same tasks. Pick the one your team has agreed on and learn it deeply rather than ping-ponging between them.",
        },
        {
          kind: "text",
          markdown:
            "## When to give up on a prompt\n\nIf you've iterated three or four times and the answer is still wrong in the same way, the model probably can't do this with what you've given it. Either:\n\n1. **The task needs more context** — a real example, the actual document, a constraint you've been keeping in your head. Paste it in.\n2. **The task needs to be broken up** — instead of \"write the whole proposal,\" do an outline first, then each section, then the polish pass.\n3. **The task isn't a model task** — it's a lookup, a calculation, or a judgment that needs you, not it.\n\nKnowing when to stop prompting is as valuable as knowing how to prompt.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "Which prompt is most likely to produce a usable first draft?",
            choices: [
              {
                id: "a",
                label: "\"Write an email to a client.\"",
              },
              {
                id: "b",
                label:
                  "\"You're a project manager. Draft a short email to a long-term client telling them their February delivery will slip by two weeks because of a vendor delay. Apologetic but not grovelling, under 150 words, end with a concrete new date.\"",
              },
              {
                id: "c",
                label: "\"Write a really good professional email please.\"",
              },
              {
                id: "d",
                label:
                  "\"Email about delay — make it sound like me, you know how I write.\"",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "mcq",
            promptMd:
              "The model's first answer is close but the tone is too formal. What's the best move?",
            choices: [
              {
                id: "a",
                label:
                  "Start a brand new chat with a longer prompt about tone",
              },
              {
                id: "b",
                label:
                  "Reply in the same chat asking it to loosen the tone and keep the rest",
              },
              {
                id: "c",
                label: "Accept it — you can fix the tone yourself later",
              },
              {
                id: "d",
                label:
                  "Switch to a different model and hope that one writes more casually",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "Showing the model two real examples of what \"good\" looks like is usually more effective than describing the style in adjectives.",
            correctValue: true,
          },
          {
            kind: "mcq",
            promptMd:
              "You've prompted four different ways and the model keeps inventing details about a specific client's contract. What's the right call?",
            choices: [
              {
                id: "a",
                label:
                  "Keep prompting — eventually the right phrasing will unlock the answer",
              },
              {
                id: "b",
                label:
                  "Stop. The model doesn't have the contract. Either paste it in (if policy allows) or do this part yourself",
              },
              {
                id: "c",
                label:
                  "Ask the model to guess but mark uncertain parts with a question mark",
              },
              {
                id: "d",
                label: "Send the output anyway and let the client correct it",
              },
            ],
            correctChoiceId: "b",
          },
        ],
      },
    },
    {
      title: "Claude Code for the Terminal",
      estMinutes: 5,
      blocks: [
        {
          kind: "text",
          markdown:
            "## What Claude Code actually is\n\nClaude Code is Claude — the same model engineers chat with in a browser — but running in your **terminal**, with the ability to read and write files in a real repository, run commands, and use tools.\n\nThe leverage is that it stops being a chat about your code and starts being an agent **inside** your code. You can say *\"find every place we hardcode a brand color and pull them into a theme file\"* and it will grep, read the matches, propose a plan, edit the files, and run the tests — without you copy-pasting snippets back and forth.\n\nIf you're not an engineer, you'll probably never run it yourself. But understanding what it does helps you understand why a developer using it can ship a small feature in an afternoon that used to take a week.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**The canonical reference is Anthropic's own engineering team:** [Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices). If you take one piece of advice on this whole lesson, it's: read that doc, then re-read it after a week of actually using the tool.",
        },
        {
          kind: "text",
          markdown:
            "## Slash commands — the muscle memory\n\nInside a Claude Code session, commands starting with `/` are how you steer it. The ones worth memorizing first:\n\n- `/init` — scaffolds a `CLAUDE.md` for the current repo (more on that below).\n- `/clear` — wipes the conversation history. Use it between unrelated tasks so old context doesn't bleed in.\n- `/compact` — summarizes the conversation so far and continues from the summary. Useful when you've gone deep and the context window is filling up.\n- `/review` — runs a code review on pending changes.\n- `/model` — switch which Claude model is doing the work (Opus for hard reasoning, Sonnet for speed).\n- `/help` — list every command. Worth scrolling through once a month; new ones land regularly.\n\nYou can also write your own — slash commands are just Markdown files in `.claude/commands/`. Teams often keep shared ones in the repo so a `/deploy` or `/release` does the same thing for everyone.",
        },
        {
          kind: "text",
          markdown:
            "## CLAUDE.md — the project memory\n\nA `CLAUDE.md` file at the root of a repo is the **persistent instructions** the model loads on every session in that repo. Conventions, where things live, what *not* to touch, hard rules.\n\nGood entries are short and load-bearing:\n\n- *\"All new tables go in the `lms` schema, never `dbo`.\"*\n- *\"Brand colors come from the tenant theme package — never hardcode hex values.\"*\n- *\"Anthropic SDK calls go through `lib/ai/claude.ts` only.\"*\n\nBad entries are vague pep talks (*\"write good code\"*) or restate what the model already knows. If a rule has been broken in this repo and someone had to fix it, that rule belongs in `CLAUDE.md`. If it hasn't, leave it out — every line in there costs tokens on every turn.\n\nThere's also a **global** `CLAUDE.md` at `~/.claude/CLAUDE.md` for instructions that apply across every project on your machine.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**Plan mode before you let it loose.** Hit `Shift+Tab` to toggle plan mode. The model thinks through what it's about to do and shows you a plan — files it will touch, commands it will run — before doing anything. For any change touching more than two files, use it. The few seconds of reading saves you reviewing a wrong-headed PR.",
        },
        {
          kind: "text",
          markdown:
            "## When to start a new conversation\n\nLong conversations get expensive and the model gets foggy. Start fresh when:\n\n- You're switching to an unrelated task. A debugging session and then \"now help me write release notes\" deserves a new chat.\n- The context window is filling up (Claude Code shows you). `/compact` buys time; `/clear` resets fully.\n- The model has gone down a wrong path and you can feel it stuck. Cheaper to brief it again from scratch than to argue it out of a bad assumption.\n- You're about to give it sensitive context (a real customer's data, a credential) — actually, don't. See lesson four. But if you ever have to, isolate it in a one-shot session and clear it immediately after.\n\nThink of each conversation as a working session with a contractor. Keep them focused, end them cleanly, start the next one with a fresh brief.",
        },
      ],
      quiz: {
        passingScore: 70,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "What is `CLAUDE.md` for?",
            choices: [
              {
                id: "a",
                label:
                  "A user manual for end-users of your application",
              },
              {
                id: "b",
                label:
                  "Persistent instructions and conventions Claude Code loads every time you open a session in that repo",
              },
              {
                id: "c",
                label:
                  "A log file of every Claude conversation you've had in the repo",
              },
              {
                id: "d",
                label:
                  "The system prompt sent to Claude only when you explicitly attach it",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "mcq",
            promptMd:
              "You've been deep in a debugging session for an hour and now want to switch to writing release notes for the same project. What's the right move?",
            choices: [
              {
                id: "a",
                label:
                  "Keep going in the same conversation — the model has lots of useful context",
              },
              {
                id: "b",
                label:
                  "Run `/clear` (or start a new conversation) and brief the model fresh for the release notes task",
              },
              {
                id: "c",
                label:
                  "Quit Claude Code and reopen your editor, then ask the chatbot in your browser instead",
              },
              {
                id: "d",
                label:
                  "Paste the entire debugging transcript into a new prompt so the model has full history",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "mcq",
            promptMd:
              "What does plan mode do?",
            choices: [
              {
                id: "a",
                label:
                  "Shows you the files Claude will touch and commands it will run before it actually does anything",
              },
              {
                id: "b",
                label:
                  "Schedules Claude to run the task overnight when costs are lower",
              },
              {
                id: "c",
                label:
                  "Locks Claude to read-only mode forever for the current repo",
              },
              {
                id: "d",
                label:
                  "Skips planning and runs the task as quickly as possible",
              },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "tf",
            promptMd:
              "A good `CLAUDE.md` entry is a short, load-bearing rule — like \"all new tables go in the `lms` schema, never `dbo`\" — rather than a vague piece of encouragement like \"write good code.\"",
            correctValue: true,
          },
        ],
      },
    },
    {
      title: "The \"Never Paste\" Rule",
      estMinutes: 5,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Why this lesson exists\n\nEverything in the first three lessons is about getting more out of AI. This one is about not blowing up the company while you do it.\n\nWhen you paste text into a free or personal AI tool — `chat.openai.com` on your personal account, the Claude consumer app, a random ChatGPT wrapper site — you are sending that text to a third party. Depending on the product and the settings, it may be:\n\n- Stored on their servers.\n- Used to train future models.\n- Visible to their support staff.\n- Logged in places you can't subpoena it back from.\n\nFor your grocery list, that's fine. For a client's PII or a chunk of a private company repo, that's a breach — even if nothing bad ever visibly happens, you've handed protected information to a vendor with no contract covering it. That's not a slap on the wrist; it can void client agreements and trigger notification obligations.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "**The rule is not \"be careful what you paste.\" The rule is: never paste these things into a public AI tool. Not once, not \"just to try something,\" not \"I'll delete the chat after.\" Once it leaves your machine, you've lost control of it.**",
        },
        {
          kind: "text",
          markdown:
            "## What never goes into a public AI tool\n\nThe non-exhaustive list — if it's any of these, **stop**:\n\n- **Client data of any kind.** Names, contact info, account numbers, contract terms, flight records, financials, internal communications. Anything a client gave us with the expectation we'd protect it.\n- **Customer PII.** Email addresses, phone numbers, addresses, SSNs, dates of birth, government IDs, payment info. Even one row.\n- **Secrets and API keys.** Connection strings, bearer tokens, private keys, anything from `.env`, anything from your password manager, passwords. Pasting a key into a chat is the same as posting it publicly — assume it's burned and rotate it.\n- **Proprietary code under NDA.** Code we wrote for a specific client. Code a partner shared with us. Anything where the contract says we'll keep it confidential.\n- **Anything from a private company repo without thinking.** Most company repos are not public. Pasting a function out of one into ChatGPT to ask \"why is this broken\" is a data exfiltration event, even if you intended no harm.\n- **HR and personnel data.** Salaries, performance reviews, disciplinary notes, candidate evaluations.\n- **Strategic / non-public business info.** Pricing, pipeline, acquisitions, anything you wouldn't tweet.\n\nA useful gut check: *\"Would I be comfortable if this text showed up on the front page of Hacker News tomorrow?\"* If no, it doesn't go in.",
        },
        {
          kind: "text",
          markdown:
            "## What you should use instead\n\n{{company_name}} has approved channels precisely so you don't have to choose between *get the AI leverage* and *protect the client*. Use them. The exact tools vary from company to company; the usual ones look like this:\n\n- **Microsoft Copilot inside the company tenant** — Copilot in Outlook, Teams, Word, Excel, etc. Data stays inside {{company_name}}'s Microsoft 365 tenant. It's covered by the same data protection terms as the rest of M365 and isn't used to train public models. This is the right tool for anything touching your email, a document on SharePoint, or a Teams chat.\n- **A company AI account, such as Claude for Work** — accessed through your company sign-in, not a personal login. Conversations sit under our enterprise terms: no training on our data, retention controls, audit logging. This is the right tool for longer-form work with internal context — drafting against an internal doc, reasoning about a client situation, working with code.\n- **Claude Code with a CLAUDE.md that says what's sensitive** — for engineers, this is the in-repo tool. Same enterprise terms as Claude for Work when signed in with the company account.\n\nIf you're not sure which channel is approved for a specific kind of data, ask IT at {{support_email}} *before* you paste. Two minutes of asking beats two weeks of incident response.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**Default workflow:** open your company's approved AI tool, not the personal one. If your browser is logged into both, color-code the windows or use separate profiles so you can tell at a glance which account you're in. Most \"oh no\" pastes happen because someone meant to use the work tool and was in the personal one.",
        },
        {
          kind: "text",
          markdown:
            "## If you already pasted something you shouldn't have\n\nMistakes happen. The wrong response is to hide it; the right one is fast and boring:\n\n1. **Tell IT at {{support_email}} (or your manager) immediately.** Time is the variable that matters. Same rule as phishing — speed limits the damage.\n2. **If it was a secret or credential, rotate it now.** Assume it's compromised. Change the password, regenerate the key, revoke the token.\n3. **Try to delete the conversation** from the AI tool's history. It may or may not actually be gone server-side, but do it anyway and screenshot that you did.\n4. **Note what was pasted and when.** Security will need this to decide whether a client has to be told.\n\nYou will not be in trouble for reporting an accidental paste quickly. You *will* be in trouble for hiding one and letting it surface later. The company would rather absorb a near-miss than a breach.",
        },
      ],
      quiz: {
        passingScore: 90,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "A client emailed you a spreadsheet of their employees with names, emails, and salaries. You want to summarize it. Where should you do that work?",
            choices: [
              {
                id: "a",
                label:
                  "Paste the spreadsheet into ChatGPT on your personal account — it's faster",
              },
              {
                id: "b",
                label:
                  "Paste it into Claude on your personal anthropic.com account — Claude is enterprise-grade",
              },
              {
                id: "c",
                label:
                  "Use a company-approved tool with enterprise data terms, such as Copilot in {{company_name}}'s Microsoft 365 tenant or a company Claude account",
              },
              {
                id: "d",
                label:
                  "Anonymize the names by hand first, then paste it anywhere",
              },
            ],
            correctChoiceId: "c",
          },
          {
            kind: "mcq",
            promptMd:
              "You're debugging a script and the easiest way to ask ChatGPT what's wrong is to paste the full file — which happens to include an API key in a comment at the top. What do you do?",
            choices: [
              {
                id: "a",
                label:
                  "Paste it — you'll delete the chat afterward so it won't matter",
              },
              {
                id: "b",
                label:
                  "Paste it but tell ChatGPT to ignore the key for security reasons",
              },
              {
                id: "c",
                label:
                  "Remove the key first, AND treat any key that was ever in pasted text as compromised and rotate it",
              },
              {
                id: "d",
                label:
                  "Use a different AI tool that promises not to log anything",
              },
            ],
            correctChoiceId: "c",
          },
          {
            kind: "tf",
            promptMd:
              "Deleting a chat in ChatGPT or Claude after you've pasted client data is enough to undo the exposure.",
            correctValue: false,
          },
          {
            kind: "mcq",
            promptMd:
              "You realize you pasted a chunk of a private company repo into your personal ChatGPT to ask a question. What's the right move?",
            choices: [
              {
                id: "a",
                label:
                  "Delete the conversation and don't mention it — nothing bad happened",
              },
              {
                id: "b",
                label:
                  "Tell IT or your manager right away, delete the conversation, and note what you pasted",
              },
              {
                id: "c",
                label:
                  "Email the snippet to the client first so they know before IT does",
              },
              {
                id: "d",
                label:
                  "Wait a week — if nothing shows up in the news, ignore it",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "mcq",
            promptMd:
              "Which of these is **safe** to paste into a personal ChatGPT account?",
            choices: [
              {
                id: "a",
                label:
                  "A client's flight maintenance log so you can summarize trends",
              },
              {
                id: "b",
                label:
                  "A draft of your personal cover letter for a job application",
              },
              {
                id: "c",
                label:
                  "A function from a private company repo so it can suggest a refactor",
              },
              {
                id: "d",
                label:
                  "An internal pricing sheet so it can format it as a table",
              },
            ],
            correctChoiceId: "b",
          },
        ],
      },
    },
  ],
};

export default course;
