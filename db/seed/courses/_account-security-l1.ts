import type { LessonSeed } from "@/db/seed/course-seed";

export const lesson: LessonSeed = {
  title: "Why a Password Manager — and Setting Up 1Password",
  estMinutes: 5,
  blocks: [
    {
      kind: "text",
      markdown:
        "## One reused password is one breach away from all of them\n\nMost account takeovers don't start with a clever hack. They start with a password you reused.\n\nA random site you signed up for years ago gets breached. The attackers grab the email + password list and try the same combination on every service that matters — Microsoft 365, your bank, GitHub, Amazon, Slack. If you reused that password anywhere, those accounts fall in minutes. This is called **credential stuffing**, and it is the single most common way small and mid-sized companies get compromised.\n\nThe only real defense is a **different, long, random password for every site**. Nobody can remember dozens of those. That is what a password manager is for.",
    },
    {
      kind: "callout",
      variant: "warning",
      markdown:
        "**If you use the same password in two places, treat both as already compromised.** It is not a question of if the weaker site gets breached — it is when.",
    },
    {
      kind: "text",
      markdown:
        "## What a password manager actually does\n\nA password manager is three things working together:\n\n- **An encrypted vault** that holds your logins. Only you can decrypt it, with your account password and Secret Key. Even the vendor can't read it.\n- **A generator** that creates long, random, unique passwords for every new account, so you never have to invent or remember one.\n- **Autofill** in your browser and on your phone that types the right password into the right site — and refuses to fill on a lookalike domain, which quietly kills most phishing pages.\n\nYou stop remembering passwords. You remember one strong account password, and the manager handles the rest.",
    },
    {
      kind: "text",
      markdown:
        "## Install 1Password — three places\n\nThis lesson walks through **1Password Business**; if {{company_name}} uses a different business password manager, the same three installs apply. You need it in three places so your logins follow you everywhere:\n\n1. **Mac desktop app** — install 1Password 8 from `1password.com/downloads`. Sign in with your `@{{work_email_domain}}` account using the company sign-in link IT sent you (it carries your Secret Key, so you won't have to type it).\n2. **Browser extension** — install the 1Password extension in every browser you use (Safari, Chrome, Edge). The extension is what does autofill and password capture.\n3. **Mobile app** — install 1Password from the App Store or Play Store on your phone, sign in with the same company account, and turn on Face ID / fingerprint unlock. This is what fills passwords into mobile apps and lets you approve sign-ins from anywhere.\n\nAll three stay in sync automatically. A password you save on your laptop is on your phone seconds later.",
    },
    {
      kind: "callout",
      variant: "info",
      markdown:
        "**Save the Emergency Kit IT gave you somewhere safe — print it, or store it in your personal vault on a separate device.** It contains your Secret Key, which you'll need to add 1Password to a new device. Without it, you're locked out.",
    },
    {
      kind: "text",
      markdown:
        "## Get your existing logins into the vault\n\nDon't try to do this in one sitting. Two paths, used together, work best:\n\n- **Import from your browser.** If Chrome, Safari, or Edge has been saving passwords for you, export them and import the file into 1Password (`Settings → Import`). This gets the bulk of your accounts into the vault in one shot. Delete the export file afterward and turn off the browser's built-in password saving so it stops competing with 1Password.\n- **Let 1Password capture as you go.** Over the next week, every time you sign into something, 1Password will offer to save it. Say yes. Within a week or two, every site you actually use will be in the vault. The ones you never sign into don't matter.\n\nAs you go, replace weak or reused passwords. Open the item in 1Password, click the password field, choose **Generate new password**, save, and update the site. Watchtower (built into 1Password) will flag the reused ones for you.",
    },
    {
      kind: "text",
      markdown:
        "## Personal, Employee, and Shared vaults — keep them separate\n\nYour 1Password Business account gives you several vaults. Use them on purpose:\n\n- **Employee** — your personal work vault. Your `@{{work_email_domain}}` logins, your dev tool accounts, anything that belongs to *you at {{company_name}}*. Only you can see it.\n- **Shared vaults** (e.g. *Engineering*, *Ops*, *IT-Admins*) — team-owned secrets that more than one person needs. Production keys, shared service accounts, the office Wi-Fi password. Ask IT ({{support_email}}) before creating a new one.\n- **Private / Personal** — your non-work life. Personal email, banking, Netflix. Lives in the same app but stays off any company shared vault.\n\nThe rule: **work passwords in work vaults, personal passwords in personal**. When someone leaves {{company_name}}, their Employee vault is removed and shared vaults stay with the team — that only works if things are filed in the right place.",
    },
    {
      kind: "callout",
      variant: "tip",
      markdown:
        "**Learn one shortcut: `⌘ ⇧ Space` (Cmd-Shift-Space) on Mac.** That's 1Password Quick Access. Hit it anywhere, type the name of a site, press Enter — it fills the login. This is the one habit that makes using a password manager faster than not using one.",
    },
  ],
  quiz: {
    passingScore: 80,
    questions: [
      {
        kind: "mcq",
        promptMd:
          "Why is reusing the same password across multiple sites considered the root cause of most account takeovers?",
        choices: [
          {
            id: "a",
            label:
              "Reused passwords are usually shorter than unique ones",
          },
          {
            id: "b",
            label:
              "When any one site is breached, attackers try the same email + password on every other service — and the matching ones fall instantly",
          },
          {
            id: "c",
            label:
              "Browsers refuse to save passwords that are reused, leaving you without autofill",
          },
          {
            id: "d",
            label:
              "Reused passwords expire faster, forcing constant resets",
          },
        ],
        correctChoiceId: "b",
      },
      {
        kind: "mcq",
        promptMd:
          "You're setting up 1Password for work. Which combination of installs should you end up with?",
        choices: [
          {
            id: "a",
            label:
              "Just the Mac desktop app — the browser will pick it up automatically",
          },
          {
            id: "b",
            label:
              "Just the browser extension — that's where autofill happens",
          },
          {
            id: "c",
            label:
              "The Mac desktop app, the browser extension in each browser you use, and the mobile app on your phone",
          },
          {
            id: "d",
            label:
              "The mobile app only, and scan a QR code each time you need a password on your laptop",
          },
        ],
        correctChoiceId: "c",
      },
      {
        kind: "mcq",
        promptMd:
          "A teammate needs the shared production API key your team uses. Where should that credential live?",
        choices: [
          {
            id: "a",
            label:
              "In your Employee vault, and you DM it to them when they ask",
          },
          {
            id: "b",
            label:
              "In a team shared vault (e.g. Engineering), so anyone on the team can access it directly",
          },
          {
            id: "c",
            label:
              "In your Private vault, so it's protected by your personal account",
          },
          {
            id: "d",
            label:
              "In a pinned Slack message, so the team can find it quickly",
          },
        ],
        correctChoiceId: "b",
      },
      {
        kind: "mcq",
        promptMd:
          "You just installed 1Password and have years of logins saved in Chrome. What's the recommended way to get them into the vault?",
        choices: [
          {
            id: "a",
            label:
              "Re-type every password from memory into 1Password by hand",
          },
          {
            id: "b",
            label:
              "Export passwords from Chrome and import them into 1Password, and let 1Password capture the rest as you sign in over the next week",
          },
          {
            id: "c",
            label:
              "Leave them in Chrome and only use 1Password for new accounts going forward",
          },
          {
            id: "d",
            label:
              "Email yourself a list of your logins so you have a backup before importing",
          },
        ],
        correctChoiceId: "b",
      },
      {
        kind: "tf",
        promptMd:
          "1Password's browser autofill helps protect you from phishing because the extension won't fill your saved password on a lookalike domain that doesn't match the real site.",
        correctValue: true,
      },
    ],
  },
};
