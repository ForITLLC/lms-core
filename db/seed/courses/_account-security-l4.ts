import type { LessonSeed } from "@/db/seed/course-seed";

export const lesson: LessonSeed = {
  title: "Lock Down Your Devices",
  estMinutes: 4,
  blocks: [
    {
      kind: "text",
      markdown:
        "## Why the device itself matters\n\nA strong password, MFA, and a passkey on every site shut down attacks that come **over the network**. They do nothing about the attack that comes from across the table.\n\nLaptop left on a cafe table while you grab your coffee. Phone forgotten in an Uber. Bag stolen out of a rental car. The moment someone has your unlocked device in their hands, every account you're already signed into is theirs — your email, your password manager, your 1Password vault, your Slack, your everything.\n\nTwo cheap settings stop almost all of that damage: **the screen locks itself quickly**, and **the disk is encrypted** so a thief can't just pull the drive and read it on another machine.",
    },
    {
      kind: "callout",
      variant: "info",
      markdown:
        "**Lock + encrypt is the floor.** Without both, every other security control you've set up can be bypassed by someone holding the device.",
    },
    {
      kind: "text",
      markdown:
        "## Mac\n\n**Screen lock:**\n\n1. **System Settings → Lock Screen.**\n2. Set **\"Require password after screen saver begins or display is turned off\"** to **Immediately**.\n3. Set **\"Start Screen Saver when inactive\"** to **5 minutes** or less.\n\nTouch ID does the unlocking, so you barely notice the lock is there.\n\n**Disk encryption (FileVault):**\n\n1. **System Settings → Privacy & Security → FileVault.**\n2. If it says **On**, you're done — FileVault has been the default on new Macs for years.\n3. If it's off, turn it on. Store the recovery key in 1Password, not in a Note on your desktop.\n\n## Windows\n\n**Screen lock:**\n\n1. **Settings → Personalization → Lock screen → Screen timeout settings.**\n2. Set both **Screen** and **Sleep** to **5 minutes** or less, on battery and plugged in.\n3. Make sure **Windows Hello** (face, fingerprint, or PIN) is set up — that's what makes the lock fast enough to live with.\n\n**Disk encryption:**\n\n1. **Settings → Privacy & security → Device encryption** (on Home) or **BitLocker** (on Pro).\n2. Verify it's on. If not, turn it on.\n3. Save the recovery key to 1Password.",
    },
    {
      kind: "callout",
      variant: "warning",
      markdown:
        "**Never save a disk recovery key in a file on the same disk it unlocks.** That's like taping the spare key to the front door. 1Password (or another vault on a different device) is the right home for it.",
    },
    {
      kind: "text",
      markdown:
        "## iPhone\n\n1. **Settings → Display & Brightness → Auto-Lock → 30 seconds** (or 1 minute).\n2. **Settings → Face ID & Passcode** — make sure Face ID is set up and your passcode is at least 6 digits.\n3. Optional but worth it on a work phone: at the bottom of that same screen, turn on **Erase Data** — after 10 failed passcode attempts the phone wipes itself.\n\niPhones are encrypted by default whenever a passcode is set, so there is no separate encryption switch to flip.\n\n## Android\n\n1. **Settings → Display → Screen timeout → 30 seconds** or 1 minute.\n2. **Settings → Security** — set up fingerprint or face unlock and a PIN/password as the fallback.\n3. Confirm **encryption** is on under **Settings → Security**. On modern Android it's on by default once you set a screen lock; older devices may need it turned on explicitly.",
    },
    {
      kind: "text",
      markdown:
        "## Find My (and what to do when something disappears)\n\nTurn on remote-find on every device, **before** you need it:\n\n- **iPhone / Mac:** Settings / System Settings → your name → **Find My** → turn on Find My iPhone / Find My Mac, plus **Send Last Location**.\n- **Android:** Settings → Security → **Find My Device** → On.\n- **Windows laptop:** Settings → Privacy & security → **Find my device** → On.\n\nIf a device is lost or stolen:\n\n1. **Tell {{company_name}} IT immediately** at {{support_email}} — even if you think you'll find it in an hour. They'll review your accounts for unusual sign-ins while you're still searching.\n2. **Remotely lock or wipe it** from another device you're signed in on, or from **icloud.com/find**, **google.com/android/find**, or **account.microsoft.com/devices**.\n3. **Change the password** on any account you can't immediately confirm is still safe — start with email, then 1Password, then anything financial.",
    },
    {
      kind: "callout",
      variant: "tip",
      markdown:
        "**Remote wipe only works if Find My was on before the device was lost.** Take two minutes today to check every device you own — it's the difference between \"annoying afternoon\" and \"identity-theft cleanup.\"",
    },
  ],
  quiz: {
    passingScore: 80,
    questions: [
      {
        kind: "mcq",
        promptMd:
          "You use a long unique password, MFA, and a passkey for every site. Why do you still need a fast screen lock and disk encryption on your laptop?",
        choices: [
          {
            id: "a",
            label:
              "You don't — strong sign-in security on every site is enough on its own",
          },
          {
            id: "b",
            label:
              "Those protect you over the network; they don't help when someone physically has your unlocked laptop or can pull the drive",
          },
          {
            id: "c",
            label:
              "Disk encryption makes the laptop faster",
          },
          {
            id: "d",
            label:
              "Screen lock is required by Microsoft 365 to receive email",
          },
        ],
        correctChoiceId: "b",
      },
      {
        kind: "mcq",
        promptMd:
          "Where should you store your FileVault or BitLocker recovery key?",
        choices: [
          {
            id: "a",
            label: "In a text file on your desktop, so it's easy to find",
          },
          {
            id: "b",
            label: "Printed and taped to the bottom of the laptop",
          },
          {
            id: "c",
            label:
              "In 1Password (or another vault that lives on a different device)",
          },
          {
            id: "d",
            label:
              "Memorized — never write it down anywhere",
          },
        ],
        correctChoiceId: "c",
      },
      {
        kind: "tf",
        promptMd:
          "You can remotely wipe a stolen phone or laptop even if Find My / Find My Device was never turned on, as long as it was signed in to your account.",
        correctValue: false,
      },
      {
        kind: "mcq",
        promptMd:
          "Your work laptop is stolen from a coffee shop. It was awake and unlocked when you stepped away. What's the right first move?",
        choices: [
          {
            id: "a",
            label:
              "Wait a day to see if someone returns it before alerting anyone",
          },
          {
            id: "b",
            label:
              "Tell {{company_name}} IT immediately, then remotely lock or wipe the laptop and change the password on your email and 1Password",
          },
          {
            id: "c",
            label:
              "Only report it once you've filed the police report and insurance claim",
          },
          {
            id: "d",
            label:
              "Email the thief from another device asking them to return it",
          },
        ],
        correctChoiceId: "b",
      },
      {
        kind: "mcq",
        promptMd:
          "On a Mac, which setting combination gives you a quick automatic lock without making the machine annoying to use?",
        choices: [
          {
            id: "a",
            label:
              "Screen saver after 30 minutes, password required after 15 minutes",
          },
          {
            id: "b",
            label:
              "Screen saver after 5 minutes or less, password required immediately, Touch ID enabled to unlock",
          },
          {
            id: "c",
            label:
              "No screen saver, but lock manually with Control-Command-Q every time you stand up",
          },
          {
            id: "d",
            label:
              "Screen saver after 1 hour, no password required — FileVault is enough",
          },
        ],
        correctChoiceId: "b",
      },
    ],
  },
};
