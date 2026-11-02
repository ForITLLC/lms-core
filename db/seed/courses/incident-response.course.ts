import type { CourseSeed } from "@/db/seed/course-seed";

const course: CourseSeed = {
  slug: "incident-response",
  title: "If Something Goes Wrong — Reporting & First Hour",
  description:
    "Build the muscle memory to report fast and not turn a near-miss into a breach.",
  category: "security",
  mandatory: true,
  scheduleKind: "annual",
  tags: ["security", "incident-response", "compliance", "annual"],
  lessons: [
    {
      title: "What Counts as an Incident",
      estMinutes: 5,
      blocks: [
        {
          kind: "text",
          markdown:
            "## The definition you can actually use\n\nAn **incident** is any event where {{company_name}} data, an account, a device, or a customer system has — or **might have** — been exposed, lost, misused, or seen by the wrong person. \"Might have\" is doing a lot of work in that sentence on purpose. You don't have to prove the breach. You just have to notice the smoke.\n\nThe people who handle incidents would much rather get ten reports that turn out to be nothing than miss the one that turns out to be everything.",
        },
        {
          kind: "text",
          markdown:
            "## Concrete examples — all of these are incidents\n\n- A **laptop or phone is lost or stolen** — even \"just left in an Uber.\"\n- A **suspicious reply or callback** lands in a real thread (the vendor's email account may be compromised).\n- You **clicked a phishing link** or, worse, **entered your password** on a page from a link.\n- You **pasted client data into a public AI tool** (ChatGPT, Claude.ai, Gemini consumer) instead of an approved tenant.\n- A **secret got into a public commit** — an API key, connection string, or token pushed to a public GitHub repo.\n- A customer can see **another customer's data** in one of our apps (cross-tenant leak).\n- An account shows **unfamiliar sign-in activity** — a country you weren't in, a device you don't own, an MFA prompt you didn't trigger.\n- A **vendor told us they were breached** and our data may have been in scope.\n- A **physical visitor tail-gated** into your workspace, or you found someone in the office you don't recognize.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "**The rule that beats all the others:** if you're asking yourself \"is this an incident?\" — that itself is the answer. Report it. Let the responders decide what it is.",
        },
        {
          kind: "text",
          markdown:
            "## What is *not* the test\n\nWhether it counts as an incident does **not** depend on:\n\n- Whether you think it's your fault.\n- Whether you think anything bad will actually happen.\n- Whether the data was \"only\" internal, or \"only\" one record.\n- Whether you can fix it yourself in a minute.\n\nSeverity is the responders' call, not yours. Your job is to surface it.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**Near-misses count too.** \"I almost wired the money\" or \"I almost approved that MFA prompt\" is worth reporting. Near-misses are how we find the gap before someone else falls into it.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "You left your work laptop in the back of a cab. You're 90% sure the driver is honest and you'll get it back. What is this?",
            choices: [
              {
                id: "a",
                label:
                  "Not an incident yet — wait to see if the laptop comes back",
              },
              {
                id: "b",
                label:
                  "An incident — a lost or out-of-your-control work device is reportable, even if you expect it back",
              },
              {
                id: "c",
                label:
                  "An IT inconvenience, not a security issue — just ask for a replacement on Monday",
              },
              {
                id: "d",
                label:
                  "Only an incident if the laptop turns out to actually be stolen",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "Pasting a client's spreadsheet into the free, personal ChatGPT site to summarize it is an incident that should be reported.",
            correctValue: true,
          },
          {
            kind: "multi",
            promptMd:
              "Which of these should be reported as incidents? Select all that apply.",
            choices: [
              {
                id: "a",
                label:
                  "A vendor emails to say their systems were breached and our data may have been included",
              },
              {
                id: "b",
                label:
                  "In one of our apps, a customer screenshots a page showing another customer's data",
              },
              {
                id: "c",
                label:
                  "Your Microsoft 365 sign-in log shows a login from a country you've never visited",
              },
              {
                id: "d",
                label:
                  "You needed to install a browser extension and used the official Chrome Web Store",
              },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "mcq",
            promptMd:
              "You pushed a commit to a public GitHub repo and ten minutes later realize it contains a live API key. What is this?",
            choices: [
              {
                id: "a",
                label:
                  "Not an incident if you force-push to remove the commit before anyone sees it",
              },
              {
                id: "b",
                label:
                  "An incident — the key must be assumed compromised the moment it hit a public repo, regardless of how fast you deleted the commit",
              },
              {
                id: "c",
                label:
                  "An incident only if you can confirm someone actually used the key",
              },
              {
                id: "d",
                label: "A code-quality issue, handled in your next PR review",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "confidence",
            promptMd:
              "You're not sure whether something you saw is really an incident or just weird. What should you do?",
            choices: [
              {
                id: "a",
                label:
                  "Report it — if you're asking the question, that itself is the answer",
              },
              {
                id: "b",
                label:
                  "Wait until you can prove it's a real incident before bothering anyone",
              },
              {
                id: "c",
                label: "Ask one coworker quietly and let them decide",
              },
              {
                id: "d",
                label:
                  "Drop it — false alarms waste the security team's time",
              },
            ],
            correctChoiceId: "a",
          },
        ],
      },
    },
    {
      title: "The First Hour — What to Do, What NOT to Do",
      estMinutes: 6,
      blocks: [
        {
          kind: "text",
          markdown:
            "## The first hour matters more than the next week\n\nMost of the damage from a security incident is done in the first hour — sometimes the first ten minutes. An attacker who has your password is reading your mail right now; a key that just leaked is being scraped by bots right now; a lost laptop is in someone's hands right now.\n\nYou don't need to solve the incident. You need to do four things, in this order: **stop the bleed, report, preserve, write it down.**",
        },
        {
          kind: "text",
          markdown:
            "## DO — the four moves\n\n1. **Stop the bleed.** Whatever the obvious containment is, do it now:\n   - Account compromised? **Sign out of all sessions** in Microsoft 365 and change your password.\n   - Secret leaked? **Rotate it immediately** — assume it's already been scraped.\n   - Device lost or stolen? **Mark it lost / disable it** in Intune (or ask IT to).\n2. **Report to {{company_name}} IT, and your manager, IMMEDIATELY** through the documented channel — the security inbox / ticket / on-call number your tenant has documented. Don't DM one engineer privately and hope it gets handled.\n3. **Preserve the evidence.** Do **not** delete the suspicious email, the leaked commit, the weird sign-in entry. **Screenshot it.** Note the **exact timestamps** (your time zone, please). The responders need the original; if it's gone they're investigating blind.\n4. **Start a brief written timeline.** Plain text is fine. \"10:42 received email. 10:43 clicked link. 10:44 typed password. 10:45 realized. 10:46 sent this report.\" Memory degrades by the hour — write it while it's fresh.",
        },
        {
          kind: "callout",
          variant: "success",
          markdown:
            "**Stop-the-bleed and report happen in parallel, not in sequence.** If you can sign out of everywhere with one tap while the report is loading, do both. Don't let one wait on the other.",
        },
        {
          kind: "text",
          markdown:
            "## DON'T — five things that make it worse\n\n- **Don't notify the customer first.** Legal and comms decide notification timing and wording — there are contractual and regulatory deadlines that depend on getting this right. A well-meaning \"hey, heads up\" email to a client can blow up the response.\n- **Don't delete the evidence.** The suspicious email, the bad commit, the weird sign-in log — all of it is evidence. Deleting it to \"clean up\" destroys the responders' ability to scope the damage.\n- **Don't investigate alone for hours before reporting.** Trying to be sure before you tell anyone is the single most common way a 10-minute incident becomes a 10-day one.\n- **Don't \"wait and see if it's real.\"** The cost of a false alarm is small. The cost of waiting is unbounded.\n- **Don't post about it publicly.** No tweets, no LinkedIn, no Slack #general, no Reddit. Not until the response team says it's OK.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**The no-blame principle.** {{company_name}} judges incident response on **speed**, not on the original mistake. Clicking a phishing link is not a career event. Hiding that you clicked a phishing link, is.",
        },
        {
          kind: "text",
          markdown:
            "## Who you tell, and how\n\nUse the channel documented for your tenant — typically a dedicated security inbox, a ticket, or an on-call rotation. If you genuinely don't know the channel and the clock is ticking: tell your manager **and** email {{support_email}} marked urgent. \"I didn't know who to call\" is not a reason to delay.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "You realize you typed your Microsoft 365 password into a phishing site about a minute ago. What is the right *first* sequence of moves?",
            choices: [
              {
                id: "a",
                label:
                  "Email the customer who was the subject of the phish to warn them, then think about what to do next",
              },
              {
                id: "b",
                label:
                  "Change your password, sign out of all sessions, report to IT and your manager — all immediately, in parallel where possible",
              },
              {
                id: "c",
                label:
                  "Delete the phishing email so attackers can't see you interacted with it",
              },
              {
                id: "d",
                label:
                  "Wait an hour to see if anything weird happens on your account before bothering anyone",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "When you discover an incident, the very first call should usually be to the affected customer to let them know.",
            correctValue: false,
          },
          {
            kind: "multi",
            promptMd:
              "Which of these belong in the first-hour playbook? Select all that apply.",
            choices: [
              {
                id: "a",
                label:
                  "Screenshot the suspicious message or activity before anything else gets touched",
              },
              {
                id: "b",
                label:
                  "Start a short written timeline with timestamps while memory is fresh",
              },
              {
                id: "c",
                label:
                  "Delete the suspicious email so it can't trick anyone else on your team",
              },
              {
                id: "d",
                label:
                  "Rotate the leaked secret immediately and assume it has already been used",
              },
            ],
            correctChoiceIds: ["a", "b", "d"],
          },
          {
            kind: "mcq",
            promptMd:
              "You think you might have an incident but you're not 100% sure. You decide to spend an hour digging through logs yourself before reporting, to avoid raising a false alarm. What's wrong with that?",
            choices: [
              {
                id: "a",
                label: "Nothing — confirming before reporting is responsible",
              },
              {
                id: "b",
                label:
                  "An hour of solo investigation is an hour the attacker keeps working; speed of reporting is the thing that limits damage",
              },
              {
                id: "c",
                label:
                  "It's fine as long as you also tell your manager along the way",
              },
              {
                id: "d",
                label:
                  "Only wrong if you find evidence and then still don't report",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "confidence",
            promptMd:
              "How does {{company_name}} judge people who report incidents they caused?",
            choices: [
              {
                id: "a",
                label:
                  "On the speed and honesty of the report — the original mistake is treated as a system issue to fix, not a person issue to punish",
              },
              {
                id: "b",
                label:
                  "On whether the mistake was avoidable — careless mistakes earn a write-up",
              },
              {
                id: "c",
                label:
                  "Repeat offenders are quietly tracked and managed out over time",
              },
              {
                id: "d",
                label:
                  "It depends on how senior the person is — leaders are held to a higher standard than ICs",
              },
            ],
            correctChoiceId: "a",
          },
        ],
      },
    },
    {
      title: "Common Patterns — Walked Through",
      estMinutes: 6,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Scenario A — you clicked and typed your password\n\nYou got an email from \"Microsoft\" saying your mailbox was full. You clicked, the login page looked normal, you typed your email and password. Then you noticed the URL was `microsft-365-storage.help`. The page never loaded anything.\n\n**Stop the bleed** — open a clean tab, go to office.com directly, **change your password**, and use the *Sign out everywhere* option in your account security settings. If you reuse that password anywhere (don't, but if you do), change it there too.\n\n**Report** — open a ticket / email the security inbox / message the on-call: \"I entered my M365 password on a phishing page approximately 10:42 today. Have already changed password and signed out all sessions. Email forwarded.\"\n\n**Preserve** — forward the phishing email to the security inbox (don't delete it) and screenshot the fake page if you can still reach it.\n\n**Write up** — three lines: when the email came in, when you clicked, when you realized.",
        },
        {
          kind: "text",
          markdown:
            "## Scenario B — wrong customer's report attached\n\nYou send the *Acme Q1 Report* to your contact at Acme. Three minutes later you realize the PDF you attached is *Globex Q1 Report*. Globex's logo, Globex's numbers, Globex's people.\n\n**Stop the bleed** — do **not** send a follow-up to Acme yourself. Don't try to \"recall\" it without checking with the response team first. If you have an admin-level option to delete the message from the recipient's mailbox, ask the response team before triggering it — they may want it preserved for the timeline.\n\n**Report** — immediately tell your manager and security: \"I sent Globex's Q1 report to a contact at Acme at 14:22. Other customer's data exposed. Have not contacted Acme.\"\n\n**Preserve** — keep the sent email in your Sent folder. Don't \"clean up.\" Screenshot the recipient list and timestamp.\n\n**Write up** — what was sent, to whom, when, and what's in the attachment that's sensitive.",
        },
        {
          kind: "text",
          markdown:
            "## Scenario C — leaked secret in a public commit\n\nYou pushed a commit to a public GitHub repo. Five minutes later GitHub's secret-scanner emails you: a connection string was detected.\n\n**Stop the bleed** — **rotate the secret right now.** The credential is burned the moment it touches a public repo; automated bots scrape new commits in seconds. Force-pushing the commit out of history does **not** help — assume it was captured.\n\n**Report** — tell IT and your manager: which secret, which repo, the commit SHA, the time it was pushed, and that you have already rotated.\n\n**Preserve** — leave the commit (and GitHub's alert email) in place until told otherwise. The responders need it to scope what else might've been in adjacent commits.\n\n**Write up** — push time, scanner alert time, rotation time, anything else that might have been in the same diff.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "Notice the shape: **stop the bleed → report → preserve → write up.** The order matters. Containment first because the attacker is still working; reporting next because you can't carry this alone; preservation third because evidence is fragile; the timeline last because it's something you can keep adding to.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "You sent Globex's quarterly report to your contact at Acme by mistake. What's the right next move?",
            choices: [
              {
                id: "a",
                label:
                  "Immediately email your Acme contact asking them to delete it without reading it",
              },
              {
                id: "b",
                label:
                  "Quietly delete the sent email from your Sent folder and pretend it didn't happen",
              },
              {
                id: "c",
                label:
                  "Report to your manager and security immediately, preserve the sent message, and let the response team decide whether to recall and how to communicate with Acme",
              },
              {
                id: "d",
                label:
                  "Wait to see if Acme actually opens the attachment before escalating",
              },
            ],
            correctChoiceId: "c",
          },
          {
            kind: "tf",
            promptMd:
              "If you force-push a commit to remove a leaked API key from history fast enough, you don't need to rotate the key.",
            correctValue: false,
          },
          {
            kind: "mcq",
            promptMd:
              "After typing your password into a phishing page, which step is the *strongest* stop-the-bleed action?",
            choices: [
              {
                id: "a",
                label:
                  "Change the password AND sign out of all sessions — a stolen password is useless if the attacker's active sessions are killed and the password is no longer valid",
              },
              {
                id: "b",
                label:
                  "Just change the password — existing sessions will expire naturally",
              },
              {
                id: "c",
                label:
                  "Just sign out everywhere — the attacker won't know the password anyway",
              },
              {
                id: "d",
                label: "Turn off the laptop until IT calls you back",
              },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "In all three scenarios in this lesson, what is the consistent order?",
            choices: [
              {
                id: "a",
                label:
                  "Preserve evidence → write timeline → report → stop the bleed",
              },
              {
                id: "b",
                label: "Stop the bleed → report → preserve → write up",
              },
              {
                id: "c",
                label:
                  "Report → wait for instructions → stop the bleed → preserve",
              },
              {
                id: "d",
                label:
                  "Write up everything completely first → then report once it's a polished document",
              },
            ],
            correctChoiceId: "b",
          },
        ],
      },
    },
    {
      title: "Drills & Afterwards",
      estMinutes: 4,
      blocks: [
        {
          kind: "text",
          markdown:
            "## What actually happens after you report\n\nThe response team runs a small standard playbook. You don't need to memorize it, but knowing the shape helps you not panic when it kicks off.\n\n1. **Triage** — is this real, and how serious? Usually decided in minutes.\n2. **Scope** — what accounts, data, systems, customers are actually touched? This is where they need the evidence you preserved.\n3. **Contain** — kill sessions, rotate keys, isolate devices, block the attacker's access.\n4. **Remediate** — fix the underlying hole. Patch the bug, change the config, retrain the model, update the doc.\n5. **Learn** — a short postmortem turns the incident into a system change so this specific thing doesn't happen the same way again.",
        },
        {
          kind: "text",
          markdown:
            "## You'll be asked to help, not punished\n\nThe responders will probably want a 15-minute conversation with you to walk through what happened. They'll ask the same question several ways because details surface on the second or third pass. None of this is a deposition — they're trying to understand the chain of events.\n\nBring your written timeline. If you don't remember something, say \"I don't remember\" — guessing is worse than admitting a gap.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**Postmortems are blameless.** The output of a postmortem at {{company_name}} is a **system change** — a guardrail, a default, a piece of automation, a clearer doc — not a name and a black mark. If the same person could make the same mistake again next month, the fix didn't land.",
        },
        {
          kind: "text",
          markdown:
            "## The one habit that does the most\n\nIf you take one thing from this course: when something feels off, **report it within minutes, not hours.** That single habit is worth more than every other piece of incident-response training combined. The responders will take it from there.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "What is the typical *output* of a blameless postmortem at {{company_name}}?",
            choices: [
              {
                id: "a",
                label:
                  "A system change — a new guardrail, default, automation, or clearer doc — so the same mistake can't happen the same way again",
              },
              {
                id: "b",
                label:
                  "A written warning placed in the responsible person's HR file",
              },
              {
                id: "c",
                label:
                  "A list of who made which mistake, ranked by severity",
              },
              {
                id: "d",
                label: "Nothing formal — the team just talks it over and moves on",
              },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "tf",
            promptMd:
              "If you can't remember an exact detail during the post-incident interview, you should guess to keep the timeline complete.",
            correctValue: false,
          },
          {
            kind: "multi",
            promptMd:
              "Which of these are stages of the incident-response playbook? Select all that apply.",
            choices: [
              { id: "a", label: "Triage" },
              { id: "b", label: "Scope" },
              { id: "c", label: "Contain" },
              { id: "d", label: "Punish" },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "confidence",
            promptMd:
              "If you take one habit from this whole course, what should it be?",
            choices: [
              {
                id: "a",
                label:
                  "Report anything that feels off within minutes, not hours",
              },
              {
                id: "b",
                label:
                  "Memorize the five stages of the response playbook",
              },
              {
                id: "c",
                label:
                  "Learn to investigate suspicious activity on your own before bothering the response team",
              },
              {
                id: "d",
                label:
                  "Keep a personal copy of all incidents you've witnessed, in case the company forgets",
              },
            ],
            correctChoiceId: "a",
          },
        ],
      },
    },
  ],
};

export default course;
