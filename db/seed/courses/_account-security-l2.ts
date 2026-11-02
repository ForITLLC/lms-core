import type { LessonSeed } from "@/db/seed/course-seed";

export const lesson: LessonSeed = {
  title: "Passkeys — Phish-Proof Sign-In",
  estMinutes: 5,
  blocks: [
    {
      kind: "text",
      markdown:
        "## What a passkey actually is\n\nA passkey is a **pair of cryptographic keys** generated on your device when you sign up to a site. The **private** half never leaves the device and is unlocked by your biometric — Face ID, Touch ID, or Windows Hello. The **public** half is what the site stores in place of a password.\n\nCompare to a password: a password is a shared secret you type into whatever form claims to want it. A passkey is a secret your device proves it holds, to a site it has cryptographically verified, without anything secret ever crossing the wire.",
    },
    {
      kind: "callout",
      variant: "info",
      markdown:
        "**There is nothing to type, nothing to remember, and nothing to leak.** The biometric just unlocks the key locally — your fingerprint never leaves your device either.",
    },
    {
      kind: "text",
      markdown:
        "## Why it beats password + SMS code\n\nPassword-plus-SMS still leaves two things an attacker can steal: the password, and the code you type after it. A convincing fake login page captures both, in order, while you're sitting there.\n\nA passkey breaks that attack at the root:\n\n- **Nothing to phish.** There is no secret string to hand over on a fake page.\n- **Nothing to type.** No code to read off your phone and re-enter where an attacker can grab it.\n- **Can't be approved by accident.** Unlike a tap-to-approve MFA prompt, a passkey requires your biometric on the device the prompt came from.\n- **Domain-bound by the browser.** Your device checks the real site's domain before releasing the signature. On `microsoft-login.evil.com` your passkey simply will not fire — the math refuses.",
    },
    {
      kind: "callout",
      variant: "success",
      markdown:
        "A passkey is the first sign-in method that **can't be tricked into working on the wrong site.** That's the whole point.",
    },
    {
      kind: "text",
      markdown:
        "## Where you can use one in 2026\n\nPasskey support is now the default on the platforms that matter:\n\n- **Microsoft work or school accounts** (your {{company_name}} Microsoft 365 login)\n- **Apple ID**\n- **Google**\n- **GitHub**\n- Basically every consumer site you'd care about — banks, Amazon, PayPal, Shopify, X, LinkedIn, Dropbox, password managers themselves.\n\nIf a site you use offers a passkey, turn it on. There is no downside.",
    },
    {
      kind: "text",
      markdown:
        "## Add a passkey to your {{company_name}} Microsoft 365 account\n\n1. Go to **aka.ms/mysecurityinfo** (or in any Microsoft 365 app, **Settings → Security info**).\n2. Click **Add sign-in method → Passkey**.\n3. Follow the biometric prompt on your device.\n\nWhere it gets stored is a choice:\n\n- **1Password** — cross-device. The passkey rides with your vault, so the same key works on your Mac, your phone, and a new laptop the day you set it up.\n- **Apple Keychain or Windows Hello** — device-local (and synced inside the Apple or Microsoft ecosystem). Simpler, fewer moving parts, but tied to that ecosystem.\n\nEither is fine. If you already use 1Password for everything else, store it there.\n\nThe other big ones, in one line each:\n\n- **Apple ID** — appleid.apple.com → Sign-In and Security → Passkeys.\n- **Google** — myaccount.google.com → Security → Passkeys.\n- **GitHub** — Settings → Password and authentication → Passkeys.",
    },
    {
      kind: "callout",
      variant: "tip",
      markdown:
        "**Add at least two.** A passkey on your phone *and* one on your laptop (or one in 1Password) means losing a device is an inconvenience, not a lockout.",
    },
    {
      kind: "text",
      markdown:
        "## If you lose the device\n\nYou are not locked out. Recovery falls back, in order, to:\n\n1. **Your other passkeys** on your other devices — the reason you added more than one.\n2. **1Password-stored passkeys**, which come with you the moment you sign in to 1Password on the replacement device.\n3. **Your account's normal recovery options** (recovery email, recovery codes, IT for your {{company_name}} account) as a last resort.\n\nA stolen device by itself does not get an attacker in either — they still need your biometric or device PIN to unlock the private key.",
    },
    {
      kind: "callout",
      variant: "warning",
      markdown:
        "Adding a passkey **does not remove your password.** Until you also delete the password from your account (or your admin disables it), an attacker who phishes the old password can still sign in the old way. Add the passkey first, then retire the password once you trust the new flow.",
    },
  ],
  quiz: {
    passingScore: 80,
    questions: [
      {
        kind: "mcq",
        promptMd:
          "What makes a passkey resistant to phishing on a fake login page?",
        choices: [
          {
            id: "a",
            label:
              "It uses a longer, more complex password that's harder to guess",
          },
          {
            id: "b",
            label:
              "The browser checks the real site's domain before the device will sign anything, so a fake domain simply won't get a response",
          },
          {
            id: "c",
            label:
              "It sends you an SMS code that expires after thirty seconds",
          },
          {
            id: "d",
            label: "Your antivirus blocks the fake page before it loads",
          },
        ],
        correctChoiceId: "b",
      },
      {
        kind: "tf",
        promptMd:
          "When you set up a passkey, the private key is uploaded to the website so it can verify your identity later.",
        correctValue: false,
      },
      {
        kind: "mcq",
        promptMd:
          "You want to add a passkey to your {{company_name}} Microsoft 365 account. Where do you go?",
        choices: [
          { id: "a", label: "portal.azure.com → Active Directory → Users" },
          {
            id: "b",
            label:
              "aka.ms/mysecurityinfo → Add sign-in method → Passkey, then follow the biometric prompt",
          },
          {
            id: "c",
            label: "outlook.office.com → File → Account → Reset Password",
          },
          {
            id: "d",
            label: "Ask IT to email you a one-time setup link",
          },
        ],
        correctChoiceId: "b",
      },
      {
        kind: "mcq",
        promptMd:
          "Your phone is stolen. You had a passkey for your Microsoft account stored on it. What's true?",
        choices: [
          {
            id: "a",
            label:
              "The thief can sign in to your account as soon as they unlock the phone's screen",
          },
          {
            id: "b",
            label:
              "Your account is permanently locked — passkeys can't be recovered",
          },
          {
            id: "c",
            label:
              "You can still sign in with a passkey on another device, or via 1Password on a new device, or via your account's recovery options — and the thief still needs your biometric or device PIN to use the stolen key",
          },
          {
            id: "d",
            label:
              "You need to call Microsoft support to manually re-issue the passkey",
          },
        ],
        correctChoiceId: "c",
      },
      {
        kind: "mcq",
        promptMd:
          "Which sign-in method is hardest for an attacker to defeat with a convincing fake login page?",
        choices: [
          { id: "a", label: "A long, unique password" },
          { id: "b", label: "Password plus an SMS code" },
          { id: "c", label: "Password plus a tap-to-approve push prompt" },
          { id: "d", label: "A passkey unlocked by your biometric" },
        ],
        correctChoiceId: "d",
      },
    ],
  },
};
