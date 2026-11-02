import type { LessonSeed } from "@/db/seed/course-seed";

export const lesson: LessonSeed = {
  title: "MFA for Microsoft 365 — Authenticator + Passkey",
  estMinutes: 5,
  blocks: [
    {
      kind: "text",
      markdown:
        "## Why MFA is the wall behind your password\n\nYour password will leak. Maybe not today, maybe not from {{company_name}} — but somewhere, in some breach, on some site you reused it on five years ago, it will surface. Treat that as a certainty and plan around it.\n\nMulti-factor authentication (MFA) is the wall the attacker hits after the password gives out. They have the string of characters; they don't have your phone, your face, or the hardware key in your bag. The login fails.\n\nPair this with the prior phishing lesson: **phishing training teaches you to spot the bait, MFA makes the bait useless.** Even if a convincing fake login page captures your password, the attacker still can't get in without your second factor.",
    },
    {
      kind: "callout",
      variant: "info",
      markdown:
        "**Assume your password is already known by someone you don't trust.** MFA is what makes that assumption survivable.",
    },
    {
      kind: "text",
      markdown:
        "## Install Microsoft Authenticator and register it\n\nGet the **Microsoft Authenticator** app from the iOS App Store or Google Play. Don't grab a third-party look-alike — search for the publisher \"Microsoft Corporation.\"\n\nThen register it against your {{company_name}} work account:\n\n1. On a computer, go to `https://aka.ms/mysecurityinfo` and sign in with your `@{{work_email_domain}}` work email.\n2. Click **Add sign-in method** → **Authenticator app** → **Next**.\n3. Open Authenticator on your phone → **+** → **Work or school account** → **Scan QR code**.\n4. Scan the code shown on the computer, then complete the test prompt.\n\nThat's it — the next time you sign in to Microsoft 365, the prompt comes to that app.",
    },
    {
      kind: "text",
      markdown:
        "## Number matching defeats push-bombing\n\nThe modern Microsoft default is **number matching**, and you should leave it on. When you sign in, the login page shows a 2-digit number. Your Authenticator prompt asks you to type that number in.\n\nWhy this matters: an attacker with your password can spam approval prompts at your phone all day (the \"MFA fatigue\" attack from lesson 2). With plain tap-to-approve, one accidental tap lets them in. With number matching, they need the number on **your** screen — which they don't have. The attack stops working.\n\nIf a prompt asks you for a number you never asked for, you're not seeing a glitch — you're seeing someone trying to log in as you. Deny it, change your password, and report it.",
    },
    {
      kind: "callout",
      variant: "warning",
      markdown:
        "**SMS is the weakest factor.** SIM-swap attacks (the attacker convinces your carrier to port your number to their SIM) and SS7 protocol attacks against the cellular network are real, not theoretical. Use Authenticator or a passkey as your primary, and **remove the SMS method** at `aka.ms/mysecurityinfo` once Authenticator works.",
    },
    {
      kind: "callout",
      variant: "tip",
      markdown:
        "On the same `aka.ms/mysecurityinfo` page you can register a **passkey** as an MFA method (covered in lesson 2). A passkey is the strongest second factor available — there's no code to type, nothing to approve by accident, and nothing for a phishing site to steal.",
    },
    {
      kind: "text",
      markdown:
        "## Always have a backup method\n\nOne registered device is one dropped phone away from a lockout. Register a second method while everything still works:\n\n- A **second device** with Authenticator — an iPad alongside your phone, or a personal phone alongside your work phone.\n- A **hardware security key** (FIDO2, like a YubiKey) that lives on your keychain or in your bag.\n- A **passkey** registered on a separate device.\n\nAdd it the same way: `aka.ms/mysecurityinfo` → **Add sign-in method**. Future you, standing in an airport with a cracked phone screen, will be grateful.\n\n## If you lose your phone\n\nIf you registered a backup method, you're fine: sign in with the backup, then on `aka.ms/mysecurityinfo` **delete** the lost device's entry and add a new one when you get a replacement phone. If you didn't register a backup, contact {{company_name}} IT at {{support_email}} to reset your MFA — and the moment you're back in, register a second method so this doesn't happen twice.",
    },
    {
      kind: "callout",
      variant: "success",
      markdown:
        "**Two minutes of setup today saves a half-day lockout later.** Register Authenticator, turn off SMS, add a backup method, and you're done.",
    },
  ],
  quiz: {
    passingScore: 80,
    questions: [
      {
        kind: "mcq",
        promptMd:
          "You're signing in to Microsoft 365 and the page displays a 2-digit number. What should you do?",
        choices: [
          {
            id: "a",
            label:
              "Wait for an approval prompt on your phone and tap Approve",
          },
          {
            id: "b",
            label:
              "Type that number into the Authenticator prompt on your phone to approve the sign-in",
          },
          {
            id: "c",
            label:
              "Enter the number on the login page as a second password",
          },
          {
            id: "d",
            label: "Text the number to IT to confirm the login attempt",
          },
        ],
        correctChoiceId: "b",
      },
      {
        kind: "mcq",
        promptMd:
          "Which MFA method should you use as your primary on your {{company_name}} account?",
        choices: [
          { id: "a", label: "SMS text message codes" },
          {
            id: "b",
            label: "Microsoft Authenticator (with number matching) or a passkey",
          },
          { id: "c", label: "A voice call to your desk phone" },
          { id: "d", label: "Your password by itself if it's long enough" },
        ],
        correctChoiceId: "b",
      },
      {
        kind: "tf",
        promptMd:
          "If your Microsoft 365 password leaks in a breach, MFA prevents the attacker from logging in even though they know the password.",
        correctValue: true,
      },
      {
        kind: "mcq",
        promptMd:
          "You drop your phone in a lake. You have a hardware security key registered as a backup. What's the right move?",
        choices: [
          {
            id: "a",
            label:
              "Call IT to fully reset your account — there's nothing you can do yourself",
          },
          {
            id: "b",
            label:
              "Sign in with the hardware key, remove the lost phone at aka.ms/mysecurityinfo, and add the new phone when you get one",
          },
          {
            id: "c",
            label:
              "Turn off MFA on your account until you can replace the phone",
          },
          {
            id: "d",
            label:
              "Share your password with a coworker so they can sign in on your behalf",
          },
        ],
        correctChoiceId: "b",
      },
      {
        kind: "mcq",
        promptMd:
          "Why is SMS considered the weakest MFA factor?",
        choices: [
          {
            id: "a",
            label:
              "Text messages cost money to send and aren't free like push notifications",
          },
          {
            id: "b",
            label:
              "SIM-swap attacks and weaknesses in the cellular network (SS7) let attackers intercept the code without ever touching your phone",
          },
          {
            id: "c",
            label:
              "SMS codes are too short — only six digits — so attackers can guess them",
          },
          {
            id: "d",
            label:
              "Phones can't receive SMS while connected to Wi-Fi, so the code never arrives",
          },
        ],
        correctChoiceId: "b",
      },
    ],
  },
};
