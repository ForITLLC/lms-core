import type { CourseSeed } from "@/db/seed/course-seed";

const course: CourseSeed = {
  slug: "authoring-in-the-forit-lms",
  title: "Authoring in the LMS",
  description:
    "A guide for the people who build the training, not just take it. How the LMS works from an author's seat: the role model and catalog, the course → lesson → block → quiz structure, writing blocks that actually teach, building quizzes, AI-assisted authoring from source material, and publishing — versions, curriculum, assignment, and scheduling.",
  category: "productivity",
  mandatory: false,
  tags: ["lms", "authoring", "course-design", "instructional-design", "admin"],
  lessons: [
    {
      title: "The LMS From an Author's Seat",
      estMinutes: 7,
      blocks: [
        {
          kind: "text",
          markdown:
            "## You're on the other side of the glass now\n\nMost people meet this LMS as a learner — they open a course, click through the slides, take the quiz, get a certificate. This course is for the other job: **building the courses**.\n\nYou're an author or an admin. Your screens live under `/author` and `/admin`, not `/learn`. The thing you produce — a course — is what hundreds of learners will read. This course teaches you how to produce it well, and it does so inside the very tool it's describing. Everything below is real: the screens, the block types, the publish flow. Use this course as a reference while you build your first one.",
        },
        {
          kind: "text",
          markdown:
            "## Three roles, three jobs\n\nThe LMS recognises three roles. A person can wear more than one hat, but the jobs are distinct:\n\n| Role | What they do | Where they work |\n|---|---|---|\n| **Learner** | Takes courses, answers quizzes, earns certificates | `/learn`, `/dashboard` |\n| **Author** | Writes and structures course content | `/author`, `/admin/courses` |\n| **Admin** | Manages the catalog, curriculum, assignments, and compliance | `/admin` and everything under it |\n\nAuthor and admin overlap heavily — the admin area is gated to `admin` *and* `author` roles, so as an author you can see courses, curriculum, and assignments. The learner-only role can't reach any of it. Everything you touch is scoped to **one tenant** — the client organisation you belong to. You never see another tenant's courses, and they never see yours.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**This is a white-label, multi-tenant LMS.** Each client company is a *tenant* with its own branded portal — their logo, their colours, their own subdomain or custom domain. As an author you write content; the tenant's branding wraps around it automatically. Never hardcode a colour, a logo, or a company name into course text — write for whoever is reading, and let the theme do the dressing.",
        },
        {
          kind: "text",
          markdown:
            "## The catalog\n\nEverything an author produces lands in the **catalog** — the set of courses that exist for your tenant. Learners browse it from `/learn`; you manage it from `/admin/courses`.\n\nEach course carries a small amount of catalog metadata that controls how it's found and filed:\n\n- **Category** — one of `security`, `productivity`, or `engineering`. This drives the catalog's category grouping and even the hero illustration on each lesson.\n- **Tags** — free-form, lowercase, kebab-case labels (`onboarding`, `m365`, `incident-response`). They power the `/learn` search box and the tag-chip filters. Tags are a *finding aid*, not a permission boundary.\n- **Status** — `draft` or `published`. Draft courses are invisible to learners; only published ones reach the catalog.\n\nThe catalog is not the same thing as the *curriculum*. The catalog is everything that exists; the curriculum is the subset a tenant decides everyone should take. You'll meet curriculum in the final lesson.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "Start every new course as a **draft**. A draft is your private workshop — learners can't see it, it won't show up in search, and you can restructure it freely. Publishing is a deliberate, separate act, covered in the last lesson. Nothing you do in draft is visible until you choose to ship it.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "Which two roles can reach the admin area (`/admin` and its sub-pages)?",
            choices: [
              { id: "a", label: "Learner and author" },
              { id: "b", label: "Admin and author" },
              { id: "c", label: "Learner and admin" },
              { id: "d", label: "Only admin" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "An author in one tenant can see and edit courses that belong to a different tenant.",
            correctValue: false,
          },
          {
            kind: "multi",
            promptMd:
              "Which of these are pieces of catalog metadata that an author sets on a course? Select all that apply.",
            choices: [
              { id: "a", label: "Category (security / productivity / engineering)" },
              { id: "b", label: "Tags (lowercase, kebab-case finding aids)" },
              { id: "c", label: "Status (draft or published)" },
              { id: "d", label: "The tenant's brand colour palette" },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "mcq",
            promptMd:
              "What is the difference between the catalog and the curriculum?",
            choices: [
              {
                id: "a",
                label:
                  "They are the same thing — two names for the list of courses",
              },
              {
                id: "b",
                label:
                  "The catalog is every course that exists; the curriculum is the subset a tenant decides everyone should take",
              },
              {
                id: "c",
                label:
                  "The catalog is for admins and the curriculum is for learners",
              },
              {
                id: "d",
                label:
                  "The curriculum holds draft courses; the catalog holds published ones",
              },
            ],
            correctChoiceId: "b",
          },
        ],
      },
    },
    {
      title: "Anatomy of a Course",
      estMinutes: 7,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Four nested layers\n\nEvery course in this LMS is the same shape, all the way down. Learn the four layers once and the rest of authoring is just filling them in:\n\n| Layer | What it is | Example |\n|---|---|---|\n| **Course** | The whole training, with a title, description, category, and tags | *Handling Client Data* |\n| **Lesson** | One sitting — a few minutes of focused content | *What counts as sensitive data* |\n| **Block** | A single content unit inside a lesson | A paragraph, a callout, an image |\n| **Quiz** | The check at the end of a lesson | Three or four questions |\n\nThe nesting is strict: a course holds an ordered list of lessons; a lesson holds an ordered list of blocks; a lesson holds at most **one** quiz. There is no such thing as a free-floating block or a quiz without a lesson.",
        },
        {
          kind: "text",
          markdown:
            "## The lesson is the unit of attention\n\nA lesson should be one comfortable sitting — roughly **five to nine minutes** of reading and clicking. That's not an arbitrary number; it's the size a learner can finish without losing the thread, and it's what the `estMinutes` field on every lesson records.\n\nIf a lesson is creeping past nine or ten minutes, that's a signal to **split it**. Two focused lessons beat one sprawling one: the learner gets two natural stopping points, two quizzes reinforcing two smaller chunks, and a progress bar that actually moves. A six-lesson course feels like progress; a two-lesson course feels like a slog.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**The quiz is attached, not embedded.** When you author a lesson you list its content blocks separately from its quiz. The system appends the quiz as the final slide of the lesson automatically. You never hand-place a quiz block — you just provide the questions, and the lesson ends on them.",
        },
        {
          kind: "text",
          markdown:
            "## How a learner walks a course\n\nIn the player, the course is flattened into a sequence of **slides**. A cover slide opens it, then every block becomes a slide, each quiz becomes a slide, and a \"course complete\" slide closes it.\n\nThe learner advances one slide at a time, and the system records **progress per block** — which slides they've seen, which quizzes they've passed. That's how the dashboard knows someone is 40% through a course. As an author this matters for one reason: **every block is a slide**. A wall-of-text block is a wall-of-text slide. Breaking content into well-sized blocks isn't cosmetic — it's pacing.",
        },
        {
          kind: "text",
          markdown:
            "## Courses have versions\n\nA course is not frozen the day you publish it. When the content needs to change — a process updated, a screenshot stale, a quiz question reworded — you publish a **new version**.\n\nThe LMS keeps every version. Old lessons, blocks, and quizzes are never deleted; a new version is a fresh set of rows tagged with a new version number. This is what protects learners who are *mid-course*: someone who started on version 2 keeps seeing version 2 until they finish, even if you publish version 3 the next day. New enrolments start on the latest version; in-flight learners are never yanked onto changed content.\n\nYou don't need to manage versions by hand while authoring — just know that \"publish\" is always \"publish a version,\" and the last lesson covers what that means in practice.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "When you plan a course, sketch the **lesson list first** — six or seven titles, each a single clear idea — before you write a word of block content. A good lesson list is the course's skeleton. If you can't name the lessons, you don't yet know what the course is about.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "What is the correct nesting of the four layers, largest to smallest?",
            choices: [
              { id: "a", label: "Block → Course → Lesson → Quiz" },
              { id: "b", label: "Course → Lesson → Block, with one quiz per lesson" },
              { id: "c", label: "Lesson → Course → Quiz → Block" },
              { id: "d", label: "Course → Block → Lesson → Quiz" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "mcq",
            promptMd:
              "Roughly how long should a single lesson take a learner to complete?",
            choices: [
              { id: "a", label: "30 to 45 minutes" },
              { id: "b", label: "5 to 9 minutes" },
              { id: "c", label: "Under 1 minute" },
              { id: "d", label: "It doesn't matter — make lessons any length" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "A learner who started a course on version 2 is automatically moved to version 3 the moment an author publishes it.",
            correctValue: false,
          },
          {
            kind: "mcq",
            promptMd:
              "A lesson you're writing has grown to about twelve minutes of content. What's the best move?",
            choices: [
              {
                id: "a",
                label: "Leave it — lesson length has no recommended range",
              },
              {
                id: "b",
                label:
                  "Split it into two focused lessons, each with its own quiz",
              },
              {
                id: "c",
                label: "Delete half the content so it fits",
              },
              {
                id: "d",
                label: "Add a second quiz halfway through the lesson",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "When a course needs content changes after launch, the author publishes a new version, and the old version's lessons and blocks are kept rather than deleted.",
            correctValue: true,
          },
        ],
      },
    },
    {
      title: "Creating and Structuring a Course",
      estMinutes: 8,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Where authoring happens\n\nThere are two routes onto the author side of the LMS:\n\n- **`/author`** is the AI-assisted authoring entry point — you hand it source material and Claude drafts a course for you to review. That's the subject of a later lesson.\n- **`/admin/courses`** is where you manage courses that already exist: their version history, per-learner progress, and the feedback learners have left.\n\nAnd there is a third route that authors actually lean on most: a **seed file**. Many of the starter courses — including this one — are authored as a typed data file checked into the repository. The file describes the whole course as plain data, a loader inserts it, and re-running the loader publishes a new version. It is version-controlled, reviewable in a pull request, and impossible to fat-finger half-way through a UI session.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**A course as data.** A seed-authored course is a single object with a `slug`, `title`, `description`, `category`, `tags`, and an array of `lessons`. Each lesson has a `title`, an `estMinutes` estimate, an array of `blocks`, and an optional `quiz`. That object *is* the course — there's nothing else. If you can describe the structure, you can author it.",
        },
        {
          kind: "text",
          markdown:
            "## Slug, title, description\n\nThree fields name the course, and each one has a job:\n\n- **Slug** — the URL-safe identifier, lowercase and kebab-case (`handling-client-data`). It appears in the address bar (`/learn/<slug>`) and it is how the LMS recognises \"this is the same course\" when you republish. Pick it once; changing a slug later creates a *different* course.\n- **Title** — what the learner reads in the catalog. Make it concrete and plain: *Authoring in the LMS*, not *LMS Mastery*.\n- **Description** — one or two sentences that tell a browsing learner what they'll get and why it's worth their time. This is the text under the title on the catalog card.\n\nWrite the description for a learner deciding whether to click. Teach what the course is; don't sell it.",
        },
        {
          kind: "text",
          markdown:
            "## Adding and ordering lessons\n\nLessons live in an **ordered array** — their position in the list *is* their order in the course. The first lesson is the one the learner sees first; there's no separate sort field to wrangle.\n\nThat makes structuring a course a question of sequencing. A few rules that hold up:\n\n- **Open with orientation.** The first lesson sets up the vocabulary and mental model the rest of the course leans on.\n- **One idea per lesson.** If a lesson title needs the word \"and,\" it's probably two lessons.\n- **Build, don't scatter.** Each lesson should be usable on its own but stronger in sequence — lesson four can assume lessons one through three.\n- **Aim for six or seven lessons.** Enough to cover a real topic; few enough to finish in a sitting or two.\n- **Close with synthesis.** The last lesson ties the threads together or sends the learner off with what to do next.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "**The slug is load-bearing — don't change it casually.** Republishing a course depends on the loader matching the existing course by `(tenant, slug)`. Keep the slug stable and a republish becomes a clean new version. Change the slug and you've silently created a brand-new course, leaving the old one orphaned in the catalog with its own learners and progress.",
        },
        {
          kind: "text",
          markdown:
            "## A worked structure\n\nSay you're asked to build *Onboarding for new hires*. Resist writing prose. Write the lesson list:\n\n1. **Welcome and who we are** — orientation, the shape of the company.\n2. **Your first week, day by day** — concrete, what happens when.\n3. **The tools you'll use** — accounts, logins, where things live.\n4. **How we communicate** — channels, meetings, expectations.\n5. **Getting help when you're stuck** — who to ask, how to ask.\n6. **Your first month and beyond** — goals, check-ins, what's next.\n\nSix lessons, each a single idea, each five to nine minutes, ordered so each builds on the last. Now — and only now — you start writing blocks.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "What determines the order lessons appear in to a learner?",
            choices: [
              { id: "a", label: "Their alphabetical title order" },
              { id: "b", label: "Their position in the lessons array" },
              { id: "c", label: "A separate priority number on each lesson" },
              { id: "d", label: "The order they were most recently edited" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "Changing a course's slug after it has been published is a safe, cosmetic edit with no side effects.",
            correctValue: false,
          },
          {
            kind: "multi",
            promptMd:
              "Which of these are sound rules for structuring a course's lessons? Select all that apply.",
            choices: [
              { id: "a", label: "Open with an orientation lesson" },
              { id: "b", label: "Keep each lesson to a single idea" },
              { id: "c", label: "Aim for roughly six or seven lessons" },
              {
                id: "d",
                label: "Pack as much as possible into one or two long lessons",
              },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "mcq",
            promptMd:
              "What's the recommended first step when planning a new course?",
            choices: [
              {
                id: "a",
                label: "Write the full text of lesson one before anything else",
              },
              {
                id: "b",
                label:
                  "Sketch the lesson list — six or seven single-idea titles — before writing block content",
              },
              {
                id: "c",
                label: "Write all the quizzes first, then back-fill the content",
              },
              {
                id: "d",
                label: "Publish an empty course and add lessons live one by one",
              },
            ],
            correctChoiceId: "b",
          },
        ],
      },
    },
    {
      title: "Writing Blocks That Teach",
      estMinutes: 8,
      blocks: [
        {
          kind: "text",
          markdown:
            "## The block toolbox\n\nA block is a single content unit, and the LMS gives you a fixed set of kinds. Each becomes its own slide in the player:\n\n| Block kind | What it carries | Use it for |\n|---|---|---|\n| **text** | Markdown prose | The main teaching — explanation, tables, lists |\n| **callout** | A coloured panel of markdown | A point that should stand apart from the prose |\n| **image** | A picture with alt text and an optional caption | A diagram, screenshot, or illustration |\n| **video** | A hosted video, with an optional transcript | A recorded walkthrough or demonstration |\n| **embed** | An external player — YouTube, Vimeo, Loom | Content that already lives on a video platform |\n| **roleplay** | A persona, scenario, and grading rubric | An AI-graded practice conversation |\n\nMost lessons are built almost entirely from **text** and **callout** blocks. The others are there when the content genuinely calls for them — reach for them on purpose, not for variety's sake.",
        },
        {
          kind: "text",
          markdown:
            "## Text blocks: the workhorse\n\nA text block holds **Markdown**, and that's where almost all the teaching happens. The conventions that keep a text block readable:\n\n- **Lead with a `##` heading.** It names the idea and gives the slide a clear top.\n- **Separate paragraphs with a blank line.** Walls of text don't get read.\n- **Use `-` bullet lists** for parallel points, and **`|` tables** for anything with two or more dimensions.\n- **Bold the key term**, sparingly — one or two per block, not a highlighter sweep.\n\nKeep one text block to **one idea**. When you find yourself writing a second `##` heading inside the same block, that's the seam — split it into two blocks. Remember each block is a slide; a focused block is a focused slide.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**Callouts have four variants, and the variant is a signal.** `info` adds context or a clarification. `tip` offers a practical shortcut or a habit worth adopting. `warning` flags a mistake or a risk worth avoiding. `success` marks a check, a milestone, or a confidence-builder. Pick the variant that matches the *meaning* — a learner reads the colour before the words.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "**Don't drown the lesson in callouts.** A callout works because it interrupts the prose — it earns attention by being rare. A lesson that's five callouts in a row has no prose left to interrupt, and every panel reads as equally loud, which means none of them land. A good rhythm is two or three callouts across a lesson of five-to-seven blocks.",
        },
        {
          kind: "text",
          markdown:
            "## A rhythm that works\n\nGood lessons tend to have a shape. Across five to seven blocks:\n\n1. **A framing text block** — what this lesson is and why it matters.\n2. **Two or three teaching text blocks** — the substance, one idea each.\n3. **A callout or two, placed where they land** — an `info` to clarify a tricky point, a `warning` next to the relevant pitfall, a `tip` to make something stick.\n4. **A closing text block** — synthesis, or a worked example that pulls the ideas together.\n\nThis is a default, not a template. The point is *variation with purpose*: prose carries the teaching, callouts punctuate it, and the learner gets a slide rhythm instead of an undifferentiated scroll.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "Write every block in **plain, direct, second person** — \"you\" the learner, present tense, short sentences. Teach, don't sell. \"You publish a new version when the content changes\" beats \"Our powerful versioning engine empowers seamless content evolution.\" The voice of this very course is the target: explain the thing, then get out of the way.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "multi",
            promptMd:
              "Which of these are real block kinds available to an author? Select all that apply.",
            choices: [
              { id: "a", label: "text" },
              { id: "b", label: "callout" },
              { id: "c", label: "roleplay" },
              { id: "d", label: "spreadsheet" },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "mcq",
            promptMd:
              "You're writing a text block and find yourself starting a second `##` heading inside it. What does that usually mean?",
            choices: [
              {
                id: "a",
                label: "Nothing — text blocks should hold as much as possible",
              },
              {
                id: "b",
                label:
                  "It's the seam between two ideas — split it into two blocks",
              },
              { id: "c", label: "You should convert the block to a callout" },
              { id: "d", label: "The lesson needs a second quiz" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "mcq",
            promptMd:
              "Which callout variant best fits a note warning the learner about a common mistake?",
            choices: [
              { id: "a", label: "info" },
              { id: "b", label: "tip" },
              { id: "c", label: "warning" },
              { id: "d", label: "success" },
            ],
            correctChoiceId: "c",
          },
          {
            kind: "tf",
            promptMd:
              "Filling a lesson with five callouts in a row makes the content more engaging and is the recommended approach.",
            correctValue: false,
          },
          {
            kind: "confidence",
            promptMd:
              "You need to teach a multi-step process and want each step to stand out. What's the best block choice?",
            choices: [
              {
                id: "a",
                label:
                  "One enormous text block containing the whole process and every aside",
              },
              {
                id: "b",
                label:
                  "A framing text block, a text block with the steps as a numbered list, and a callout for the one step people get wrong",
              },
              {
                id: "c",
                label: "Five callouts, one per step, back to back",
              },
              {
                id: "d",
                label: "An embed block linking to an external document",
              },
            ],
            correctChoiceId: "b",
          },
        ],
      },
    },
    {
      title: "Quizzes and Assessment",
      estMinutes: 7,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Why each lesson ends with a check\n\nA quiz at the end of a lesson isn't a gate for its own sake. It does two jobs: it gives the **learner** a moment to retrieve what they just read — which is what actually moves it into memory — and it gives **you, the author**, a signal about whether the lesson landed.\n\nEvery lesson can carry one quiz. You provide the questions; the LMS appends the quiz as the lesson's final slide automatically. A lesson without a quiz is allowed, but for teaching content it's almost always worth the three or four questions.",
        },
        {
          kind: "text",
          markdown:
            "## The five question kinds\n\nThe LMS supports five question kinds. The first three are the ones you'll use constantly:\n\n| Kind | Shape | Best for |\n|---|---|---|\n| **mcq** | One prompt, several choices, exactly one correct | Testing a single clear concept |\n| **multi** | One prompt, several choices, one *or more* correct | \"Select all that apply\" — sets and categories |\n| **tf** | A statement that is simply true or false | A crisp misconception worth nailing down |\n| **short** | A free-text answer graded against a rubric | Open reflection, AI-graded |\n| **confidence** | An mcq that also captures how sure the learner is | Judgement calls where confidence itself matters |\n\nA healthy lesson quiz mixes kinds — a couple of `mcq`, a `multi`, a `tf`. The mix keeps the learner thinking rather than pattern-matching the answer shape.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**Choices need stable IDs.** Each choice on an `mcq`, `multi`, or `confidence` question has an `id` (a short label like `a`, `b`, `c`) and a `label` (the text the learner reads). The question's `correctChoiceId` — or `correctChoiceIds` for a `multi` — must point at IDs that genuinely exist on that question. A correct answer that references a missing ID is a broken question.",
        },
        {
          kind: "text",
          markdown:
            "## Writing questions that measure understanding\n\nA good question checks whether the learner *understood*, not whether they can spot the longest answer. Some rules that hold up:\n\n- **Test the idea, not the wording.** Ask what a concept *means* or *implies*, not whether they memorised a sentence verbatim.\n- **Make wrong answers plausible.** A distractor should be a real misconception someone could hold. Obvious-joke options teach nothing.\n- **Keep choices parallel.** Similar length, similar grammar — don't let the correct answer be the conspicuously detailed one.\n- **One idea per question.** If answering correctly needs two separate facts, it's two questions.\n- **Anchor every question in the lesson.** If the lesson didn't teach it, the quiz shouldn't test it.\n\nThree to five questions per lesson is the sweet spot — enough to check the key ideas, short enough that the learner doesn't resent it.",
        },
        {
          kind: "text",
          markdown:
            "## Passing scores\n\nEvery quiz has a **passing score** — the percentage a learner must reach to clear the lesson. A simple convention works well:\n\n- **70** — a reasonable bar for general knowledge and skills content.\n- **80** — for material where getting it wrong has real consequences: security, compliance, handling client data.\n\nA learner who falls short retakes the quiz. Set the bar to match the stakes of the content — a higher bar on a security course is a feature, not friction.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "Read each finished question as if you were a learner who skimmed the lesson. Can you still guess the answer from the *shape* alone — the longest choice, the only \"all of the above,\" the one that's grammatically different? If yes, rewrite it. A question that's beatable without understanding measures nothing.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "Which question kind lets a learner select more than one correct choice?",
            choices: [
              { id: "a", label: "mcq" },
              { id: "b", label: "multi" },
              { id: "c", label: "tf" },
              { id: "d", label: "confidence" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "On an mcq question, the `correctChoiceId` must reference the `id` of a choice that actually exists on that question.",
            correctValue: true,
          },
          {
            kind: "multi",
            promptMd:
              "Which of these are good practices when writing quiz questions? Select all that apply.",
            choices: [
              { id: "a", label: "Make wrong answers plausible misconceptions" },
              { id: "b", label: "Keep all choices similar in length and grammar" },
              { id: "c", label: "Test one idea per question" },
              {
                id: "d",
                label:
                  "Make the correct answer the longest, most detailed choice every time",
              },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "mcq",
            promptMd:
              "You're authoring a course on handling client data. Which passing score fits the convention?",
            choices: [
              { id: "a", label: "80, because the stakes of getting it wrong are real" },
              { id: "b", label: "70, the same as any general-knowledge course" },
              { id: "c", label: "50, so most learners pass on the first try" },
              { id: "d", label: "100, with no margin for error" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "How many questions per lesson quiz is the recommended sweet spot?",
            choices: [
              { id: "a", label: "Exactly one" },
              { id: "b", label: "Three to five" },
              { id: "c", label: "At least fifteen" },
              { id: "d", label: "It doesn't matter how many" },
            ],
            correctChoiceId: "b",
          },
        ],
      },
    },
    {
      title: "AI-Assisted Authoring",
      estMinutes: 7,
      blocks: [
        {
          kind: "text",
          markdown:
            "## You don't have to start from a blank page\n\nThe LMS is AI-native, and authoring is where that shows up most. Instead of writing every lesson by hand, you can hand the system **source material** — a YouTube video, a PDF, a URL, a pasted transcript — and Claude drafts a structured course from it: lessons, blocks, and quizzes, ready for you to review.\n\nThis is the job of the `/author` screen. The promise is simple: drop in source material, get back a course-shaped draft you can edit and publish. It turns authoring from \"write everything\" into \"review and refine.\"",
        },
        {
          kind: "text",
          markdown:
            "## How the pipeline works\n\nWhen you submit a source, the LMS runs it through a multi-stage pipeline. Each stage is a separate AI call, so you can watch the draft assemble itself:\n\n1. **Extract** — the system pulls the content out of the source: the transcript of a video, the text of a PDF.\n2. **Outline** — Claude reads the extract and proposes a course: a title, a description, and a list of lessons.\n3. **Blocks** — for each lesson, Claude drafts the content blocks.\n4. **Quiz** — for each lesson, Claude drafts a quiz from that lesson's material.\n\nThe result is a complete draft course — the same course → lesson → block → quiz structure you'd build by hand. The whole run is tracked, so a failed extraction or a bad source surfaces as an error rather than a half-built course.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "**AI generates, a human approves — always.** The pipeline produces a *draft*. It never publishes on its own. A drafted course can have a confident-sounding error, a quiz question that's subtly wrong, or a tone that's off for your audience. Your job as the author is to read every lesson, fix what's wrong, and only then publish. The AI does the typing; you own the result.",
        },
        {
          kind: "text",
          markdown:
            "## Reviewing an AI draft well\n\nTreat an AI draft as a strong first draft from a junior colleague — useful, fast, and in need of an editor. When you review one:\n\n- **Check facts against the source.** The AI can paraphrase a claim into something the source never said.\n- **Verify every quiz answer.** Confirm the marked-correct choice is genuinely correct and the distractors are genuinely wrong.\n- **Fix the structure.** Merge a thin lesson, split a bloated one, reorder for a better build.\n- **Match the voice.** Rewrite anything that drifts into marketing tone or jargon — plain second person, teach don't sell.\n- **Mind the length.** Trim lessons back toward that five-to-nine-minute window.\n\nThe AI gets you to 80% in minutes. The last 20% — accuracy, judgement, voice — is the part only you can do, and it's the part that makes the course trustworthy.",
        },
        {
          kind: "text",
          markdown:
            "## AI beyond a whole course\n\nAI-assisted authoring isn't only the one-shot \"course from a video\" path. The same capability shows up in smaller, targeted ways:\n\n- **Quiz from a block** — generate a set of questions from content you've already written, then edit them down.\n- **Curriculum proposals** — describe a training need in plain language (\"onboarding for new aircraft mechanics\") and the LMS proposes a curriculum drawn from your existing catalog, flagging genuine gaps as courses worth creating.\n\nThe pattern is consistent across all of them: **AI proposes, you decide.** It removes the blank page and the busywork; it never removes the author.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "The quality of an AI draft is downstream of the source you feed it. A clear, well-structured forty-minute talk produces a far better draft than a rambling, tangent-filled one. Garbage in, garbage out applies — pick a focused source, and you spend your review time refining rather than rebuilding.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "multi",
            promptMd:
              "Which of these can be used as source material for AI-assisted course authoring? Select all that apply.",
            choices: [
              { id: "a", label: "A YouTube video" },
              { id: "b", label: "A PDF" },
              { id: "c", label: "A pasted transcript" },
              { id: "d", label: "A learner's quiz score" },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "tf",
            promptMd:
              "The AI authoring pipeline publishes the generated course automatically as soon as it finishes.",
            correctValue: false,
          },
          {
            kind: "mcq",
            promptMd:
              "Which best describes the right way to treat an AI-generated course draft?",
            choices: [
              {
                id: "a",
                label:
                  "As a finished course — publish it as-is to save time",
              },
              {
                id: "b",
                label:
                  "As a strong first draft to review, fact-check, and edit before publishing",
              },
              {
                id: "c",
                label:
                  "As a throwaway — AI drafts are never worth keeping",
              },
              {
                id: "d",
                label:
                  "As learner-facing content the moment the pipeline completes",
              },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "mcq",
            promptMd:
              "In the AI authoring pipeline, which stage comes immediately after extracting the source content?",
            choices: [
              { id: "a", label: "Generating the quizzes" },
              { id: "b", label: "Publishing the course" },
              {
                id: "c",
                label: "Generating an outline — title, description, lesson list",
              },
              { id: "d", label: "Assigning the course to learners" },
            ],
            correctChoiceId: "c",
          },
          {
            kind: "confidence",
            promptMd:
              "An AI draft hands you a lesson with a quiz question whose marked-correct answer looks wrong to you. What do you do?",
            choices: [
              {
                id: "a",
                label:
                  "Trust the AI — it generated the question, so it must be right",
              },
              {
                id: "b",
                label:
                  "Check it against the lesson content and the source, and correct the answer if it's wrong before publishing",
              },
              {
                id: "c",
                label: "Delete the whole lesson to be safe",
              },
              {
                id: "d",
                label: "Publish anyway and wait for a learner to report it",
              },
            ],
            correctChoiceId: "b",
          },
        ],
      },
    },
    {
      title: "Versioning, Publishing, and Assignment",
      estMinutes: 8,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Publishing is publishing a version\n\nA course's content lives in **versions**. The first time you publish a course, the LMS creates version 1. Every later republish — a content fix, a reworded quiz, a structural change — creates version 2, version 3, and so on.\n\nCritically, the old versions are never thrown away. A republish inserts a fresh set of lessons, blocks, and quizzes tagged with the new version number; the previous version's rows stay exactly where they were. The catalog points new learners at the latest version, but the history is permanent — which is what makes versioning safe to use freely.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**In-flight learners are protected.** Each learner's enrolment is pinned to the version they started on. Someone halfway through version 2 keeps seeing version 2 until they finish, even if you publish version 3 today. New enrolments start on the latest version; nobody is ever yanked onto changed content mid-course. That stability is the whole reason the LMS keeps every version instead of overwriting.",
        },
        {
          kind: "text",
          markdown:
            "## Mandatory versus optional\n\nA course carries a `mandatory` flag, and it changes how the course shows up:\n\n- **Mandatory** — required training. It's added to the tenant's default curriculum as a must-do, it counts on the compliance dashboard, and it can carry a due date.\n- **Optional** — recommended but not enforced. It's in the catalog for any learner who wants it, but it doesn't count against compliance.\n\nThis course — *Authoring in the LMS* — is **optional**: it's a reference for the people who build training, not compliance every employee must complete. Match the flag to reality. Marking everything mandatory makes the compliance dashboard meaningless; marking nothing mandatory makes it empty.",
        },
        {
          kind: "text",
          markdown:
            "## Curriculum and the two ways onto a course\n\nThe **curriculum** is the tenant's defined set of training — what every learner is measured against. Admins manage it from `/admin/curriculum`, marking courses mandatory or optional and setting the order they appear in.\n\nThere are exactly two paths that put a learner onto a course:\n\n1. **The default curriculum** — every learner in the tenant gets the curriculum's courses. This is the broad, everyone-gets-it path.\n2. **A manual assignment** — from `/admin/assignments`, an admin picks a specific learner and a specific course, optionally with a due date. This is the targeted, this-person-needs-this path.\n\nA manual assignment **pins the course version** at the moment it's made — so republishing the course later won't pull the assigned learner onto a different version mid-flight, exactly like an enrolment does.",
        },
        {
          kind: "text",
          markdown:
            "## Scheduling and recurrence\n\nSome training expires. A course can carry a **schedule** that drives when a learner's certificate goes stale and the course comes due again:\n\n| Schedule | Meaning |\n|---|---|\n| *(none)* | Evergreen — the certificate never expires |\n| **Annual** | Due every year — a yearly refresh, like security awareness training |\n| **Recurring** | Due every *N* months, measured from the learner's start date or last completion |\n\nAnnual and recurring schedules are how compliance training stays current — a learner who passed phishing awareness last year is brought back round this year automatically. An evergreen course, like a skills primer, is done once and stays done. Most authored courses are evergreen; reach for a schedule only when the content genuinely goes out of date.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**Branding is the tenant's, not yours.** The portal a learner sees is wrapped in their own company's logo and colours, and the LMS handles that automatically through the tenant theme. As an author, never write a brand name, a colour, or a logo into course content. Write neutral, plain text that reads correctly for whichever tenant — and whichever client — is looking at it.",
        },
        {
          kind: "callout",
          variant: "success",
          markdown:
            "**You've now seen the whole authoring loop.** Roles and the catalog; the course → lesson → block → quiz structure; building and sequencing lessons; writing blocks that teach and quizzes that measure; AI-assisted drafting; and publishing with versions, curriculum, assignment, and scheduling. Start a draft, sketch six or seven lessons, and build. Come back to this course whenever you need the reference.",
        },
      ],
      quiz: {
        passingScore: 80,
        questions: [
          {
            kind: "tf",
            promptMd:
              "Republishing a course creates a new version and keeps the previous version's lessons and blocks rather than deleting them.",
            correctValue: true,
          },
          {
            kind: "mcq",
            promptMd:
              "What are the two paths that put a learner onto a course?",
            choices: [
              {
                id: "a",
                label:
                  "The default curriculum, and a manual assignment from /admin/assignments",
              },
              {
                id: "b",
                label: "A YouTube link, and a PDF upload",
              },
              {
                id: "c",
                label: "The catalog search box, and the compliance dashboard",
              },
              {
                id: "d",
                label: "A draft, and a published version",
              },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "What does a manual course assignment pin at the moment it is created?",
            choices: [
              { id: "a", label: "The learner's quiz scores" },
              { id: "b", label: "The course version the learner will take" },
              { id: "c", label: "The tenant's brand colours" },
              { id: "d", label: "The course's category" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "multi",
            promptMd:
              "Which statements about mandatory and optional courses are correct? Select all that apply.",
            choices: [
              {
                id: "a",
                label:
                  "Mandatory courses count toward the tenant's compliance dashboard",
              },
              {
                id: "b",
                label:
                  "Optional courses are in the catalog but not enforced",
              },
              {
                id: "c",
                label: "A mandatory course can carry a due date",
              },
              {
                id: "d",
                label:
                  "Marking every course mandatory makes the compliance dashboard more useful",
              },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "mcq",
            promptMd:
              "A skills primer that doesn't go out of date should be given which schedule?",
            choices: [
              { id: "a", label: "Annual — due for a refresh every year" },
              { id: "b", label: "Recurring every 3 months" },
              {
                id: "c",
                label: "No schedule — evergreen, the certificate never expires",
              },
              { id: "d", label: "Recurring every 12 months" },
            ],
            correctChoiceId: "c",
          },
        ],
      },
    },
  ],
};

export default course;
