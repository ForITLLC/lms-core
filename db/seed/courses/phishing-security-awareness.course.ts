import type { CourseSeed } from "@/db/seed/course-seed";

const course: CourseSeed = {
  slug: "phishing-security-awareness",
  title: "Phishing & Security Awareness",
  description:
    "Spot modern phishing — fake emails, texts, calls, and QR codes — and learn the few habits that stop an attacker before they get a foothold.",
  category: "security",
  mandatory: true,
  scheduleKind: "annual",
  tags: ["security", "phishing", "compliance", "annual"],
  lessons: [
    {
      title: "Why You Are the Target",
      estMinutes: 4,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Phishing is a con, not a hack\n\nPhishing is a message designed to **trick you into doing something you'd never do if you saw it clearly** — handing over a password, approving a login, paying an invoice, or opening a file.\n\nAttackers go after people instead of firewalls because people are reachable and trusting. One convincing message can hand them what months of technical attacks could not.\n\nThey are usually after one of three things:\n\n- **Credentials** — your username and password, so they can log in as you.\n- **Money** — a payment redirected, an invoice paid, gift cards bought.\n- **A foothold** — quiet access to your account they can use to attack coworkers, customers, and systems from the inside.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**It's not about being important.** Attackers don't need the CEO. Your account is a doorway — once they're in as you, every coworker who trusts your name becomes their next target.",
        },
        {
          kind: "text",
          markdown:
            "## The \"obvious typo\" era is over\n\nForget the old advice about bad spelling and clumsy grammar. Attackers now use AI to write **flawless, personalized messages** in seconds — correct tone, real names, plausible context, your company's style.\n\nThey also clone what you already trust:\n\n- A login page that is pixel-perfect.\n- A voice on the phone that sounds like a manager.\n- A reply that slots neatly into a real email thread.\n\nJudgment, not proofreading, is what protects you now: **does this request make sense, and can I verify it?**",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "If your only phishing test is \"are there typos?\", you will be fooled. A polished, professional message is **not** evidence that it's safe.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "Why do attackers target individual employees with phishing instead of attacking firewalls or servers directly?",
            choices: [
              {
                id: "a",
                label:
                  "Firewalls are illegal to attack but social engineering is a gray area",
              },
              {
                id: "b",
                label:
                  "People are reachable and trusting — one convincing message can hand over what months of technical attacks couldn't",
              },
              {
                id: "c",
                label:
                  "Attackers are required by law to try human targets before technical ones",
              },
              {
                id: "d",
                label:
                  "Most firewalls already block all known attacks, so people are the only remaining option",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "multi",
            promptMd:
              "Which of these are things phishing attackers are typically trying to get from you? Select all that apply.",
            choices: [
              { id: "a", label: "Credentials — your username and password" },
              {
                id: "b",
                label:
                  "Money — a redirected payment, a paid invoice, or gift cards",
              },
              {
                id: "c",
                label:
                  "A foothold — quiet access to your account they can use against coworkers and customers",
              },
              {
                id: "d",
                label:
                  "Your personal opinion about their attack so they can improve",
              },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "tf",
            promptMd:
              "If a phishing email is well-written with no typos or grammar mistakes, it's probably safe.",
            correctValue: false,
          },
          {
            kind: "mcq",
            promptMd:
              "You're not a senior leader. Should you assume attackers aren't interested in your account?",
            choices: [
              {
                id: "a",
                label:
                  "Yes — attackers chase the CEO and executives; rank-and-file accounts aren't worth their time",
              },
              {
                id: "b",
                label:
                  "No — your account is a doorway; once an attacker is logged in as you, every coworker who trusts your name becomes their next target",
              },
              {
                id: "c",
                label:
                  "Yes, as long as you don't have admin permissions on any systems",
              },
              {
                id: "d",
                label:
                  "Only if you regularly handle payments or customer data — otherwise you're a low-value target",
              },
            ],
            correctChoiceId: "b",
          },
        ],
      },
    },
    {
      title: "Know the Plays",
      estMinutes: 5,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Phishing comes through every channel\n\nIt's not just email anymore. The same con arrives by text, phone, and even a QR code on a poster.\n\n| Type | Channel | What it looks like |\n|---|---|---|\n| **Spear phishing** | Email | Targeted at *you* — uses your name, role, real projects |\n| **BEC / CEO fraud** | Email | A \"boss\" or vendor urgently asks for a payment or data |\n| **Smishing** | SMS / text | \"Failed delivery,\" \"toll unpaid,\" fake MFA code |\n| **Vishing** | Phone call | A \"help desk\" or \"bank\" caller talks you into access |\n| **Quishing** | QR code | A QR code that opens a fake login page |\n| **MFA fatigue** | App push | Repeated login approvals until you tap \"Approve\" |",
        },
        {
          kind: "text",
          markdown:
            "## Business Email Compromise: the expensive one\n\nBEC skips malware entirely. The attacker just **asks**, while pretending to be someone you trust — an executive, a vendor, a colleague — and adds pressure so you act before you think.\n\nClassic moves:\n\n- *\"I'm in a meeting, can't talk — buy five gift cards and send the codes.\"*\n- *\"Our bank details have changed, please update them before the next payment.\"*\n- *\"This invoice is overdue, the client is upset, pay it today.\"*\n\nBEC drains billions from organizations every year precisely because nothing about it looks technical. It looks like a normal work request.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "**Two requests that always deserve a second channel:** changing where money is sent, and buying gift cards. No legitimate manager will mind you calling a known number to confirm. An attacker will.",
        },
        {
          kind: "text",
          markdown:
            "## MFA fatigue and push-bombing\n\nMulti-factor authentication (MFA) is one of your best defenses — an attacker with your password still can't log in without the second step.\n\nSo attackers attack the second step. With your stolen password, they trigger login attempt after login attempt, flooding your phone with **\"Approve this sign-in?\"** prompts — late at night, during meetings — betting you'll tap *Approve* just to make it stop.\n\n**A prompt you didn't start is an attack in progress.** Always *Deny*, then change your password and report it.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "Prefer **number-matching** MFA or a passkey over plain tap-to-approve. If your prompt asks you to type a number shown on screen, an attacker who doesn't have your screen can't get past it — and a passkey can't be approved by accident at all.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "What makes **Business Email Compromise (BEC)** so expensive — billions lost across organizations every year — even though no malware is involved?",
            choices: [
              {
                id: "a",
                label:
                  "It uses zero-day exploits in Outlook that most companies haven't patched",
              },
              {
                id: "b",
                label:
                  "The attacker just *asks*, while impersonating someone trusted and adding urgency — nothing about it looks technical, so it bypasses the security tools and slips past human judgment",
              },
              {
                id: "c",
                label:
                  "BEC attacks always come with hidden cryptocurrency miners attached",
              },
              {
                id: "d",
                label:
                  "It exploits a known weakness in MFA push notifications",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "multi",
            promptMd:
              "Which of these channels can phishing reach you through? Select all that apply.",
            choices: [
              { id: "a", label: "Email (spear phishing, BEC)" },
              { id: "b", label: "SMS / text messages (smishing)" },
              { id: "c", label: "Phone calls (vishing)" },
              { id: "d", label: "QR codes on posters or invoices (quishing)" },
              {
                id: "e",
                label:
                  "Repeated MFA push prompts to your phone (push-bombing / MFA fatigue)",
              },
            ],
            correctChoiceIds: ["a", "b", "c", "d", "e"],
          },
          {
            kind: "mcq",
            promptMd:
              "A vendor emails you saying their bank details have changed and asks you to redirect the next payment to a new account. What's the right move?",
            choices: [
              {
                id: "a",
                label:
                  "Update the bank details — vendor changes happen all the time",
              },
              {
                id: "b",
                label:
                  "Reply to the email to confirm it's really them, then update if they say yes",
              },
              {
                id: "c",
                label:
                  "Verify on a separate channel using a phone number you already have on file for the vendor — never the contact info in the message",
              },
              {
                id: "d",
                label:
                  "Forward the email to your manager and let them decide",
              },
            ],
            correctChoiceId: "c",
          },
          {
            kind: "tf",
            promptMd:
              "Number-matching MFA (where you type a number shown on screen) is harder for an attacker to bypass than plain tap-to-approve MFA.",
            correctValue: true,
          },
        ],
      },
    },
    {
      title: "Spot It, Stop It, Report It",
      estMinutes: 6,
      blocks: [
        {
          kind: "text",
          markdown:
            "## The red flags, in one list\n\nNo single flag is proof — but each one should make you slow down.\n\n- **Urgency and fear** — \"act now,\" \"account suspended,\" \"final notice.\" Pressure exists to stop you thinking.\n- **Lookalike sender** — `support@micros0ft-billing.com`, a vendor name spelled *almost* right, a reply-to that doesn't match the display name.\n- **Unexpected attachment or link** — especially invoices, \"voicemails,\" or files you didn't ask for.\n- **Generic greeting** — \"Dear Customer,\" \"Dear User\" — when the real sender knows your name.\n- **A request that's slightly off** — a payment change, a password \"reset,\" a login approval, a gift-card errand.\n- **Channel mismatch** — your bank \"texting\" a link, IT \"calling\" for your password, a QR code where a normal link belongs.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**Hover before you click.** On a computer, rest your pointer over a link and read the real address at the bottom of the window. On a phone, press and hold to preview it. If the destination isn't what the text promises, don't click. IT and banks **never** need your password.",
        },
        {
          kind: "text",
          markdown:
            "## What to do — three habits\n\n1. **When unsure, don't click and don't enter credentials.** A pause costs you nothing. A typed password on a fake page costs you everything.\n2. **Verify unusual requests out-of-band.** Use a phone number or address *you already know* — never the contact details in the suspicious message. The message is the thing you're checking; don't trust it to check itself.\n3. **Report it with the Report Phishing button.** Reporting warns your security team and helps them pull the same attack from your coworkers' inboxes.",
        },
        {
          kind: "callout",
          variant: "success",
          markdown:
            "**If you think you already clicked or replied — report it immediately anyway.** You are not in trouble; speed is what limits the damage. A password changed and a team alerted in the first ten minutes can stop an attack cold. Hiding a mistake is the only thing that turns a near-miss into a breach.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "An email from your CFO's correct-looking address says: *\"I'm boarding a flight — please buy four $200 gift cards for client gifts and text me the codes. Reimburse you Monday.\"* What's the best move?",
            choices: [
              {
                id: "a",
                label:
                  "Buy the cards — it came from the CFO's address and the amount is small",
              },
              {
                id: "b",
                label:
                  "Reply to the email asking the CFO to confirm it's really them",
              },
              {
                id: "c",
                label:
                  "Call or message the CFO on a number you already know to verify, before doing anything",
              },
              {
                id: "d",
                label: "Forward it to a coworker and ask them to handle it",
              },
            ],
            correctChoiceId: "c",
          },
          {
            kind: "tf",
            promptMd:
              "Because attackers now use AI, a phishing email can be perfectly written with no spelling or grammar mistakes.",
            correctValue: true,
          },
          {
            kind: "multi",
            promptMd:
              "Which of these are genuine warning signs of a phishing message? Select all that apply.",
            choices: [
              { id: "a", label: "Pressure to act urgently or face a consequence" },
              {
                id: "b",
                label:
                  "A sender domain that's spelled almost — but not exactly — right",
              },
              {
                id: "c",
                label:
                  "An unexpected request to change where a payment is sent",
              },
              {
                id: "d",
                label:
                  "The message addresses you correctly by your full name",
              },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "mcq",
            promptMd:
              "Your phone buzzes with repeated \"Approve this sign-in?\" notifications you did not trigger. What should you do?",
            choices: [
              {
                id: "a",
                label:
                  "Tap Approve once so the notifications stop interrupting you",
              },
              {
                id: "b",
                label:
                  "Deny the prompts, then change your password and report it — someone has your password",
              },
              { id: "c", label: "Ignore it; the prompts will eventually stop" },
              {
                id: "d",
                label: "Turn off MFA so the prompts can't reach you anymore",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "confidence",
            promptMd:
              "You realize you entered your password into a login page from a link in a suspicious email. What is the right thing to do?",
            choices: [
              {
                id: "a",
                label:
                  "Report it immediately and change your password — speed limits the damage",
              },
              {
                id: "b",
                label:
                  "Say nothing and hope nothing happens, to avoid getting in trouble",
              },
              {
                id: "c",
                label: "Wait until tomorrow to see if your account behaves oddly",
              },
              {
                id: "d",
                label:
                  "Delete the email so there's no evidence you interacted with it",
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
