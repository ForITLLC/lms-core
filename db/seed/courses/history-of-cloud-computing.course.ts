import type { CourseSeed } from "@/db/seed/course-seed";

const course: CourseSeed = {
  slug: "history-of-cloud-computing",
  title: "A History of Cloud Computing",
  description:
    "How computing went from room-sized machines you bought and babysat to power you rent by the minute. A plain-language tour from 1950s mainframes through the 2006 birth of the modern cloud to today's containers, serverless, and AI — no technical background required.",
  category: "engineering",
  mandatory: false,
  tags: [
    "history",
    "cloud",
    "computing",
    "aws",
    "azure",
    "internet",
    "general-knowledge",
  ],
  lessons: [
    {
      title: "Before the Cloud — Big Machines and a Bold Idea",
      estMinutes: 8,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Computing started out enormous and shared\n\nThe story of the cloud begins long before anyone used the word. In the 1950s and 60s, a computer was not a thing you owned — it was a thing your *organisation* owned, if it could afford one at all. A single machine filled a room, cost as much as a building, and needed a team of specialists to keep it running.\n\nThese machines were called **mainframes**. A university or a large company would have one, and everyone who needed computing power had to share that single machine. You didn't have a computer on your desk. You had access to *the* computer, somewhere down the hall, behind glass.",
        },
        {
          kind: "text",
          markdown:
            "## Time-sharing: many people, one computer\n\nIf a whole university has one computer, how do dozens of people use it at once? The answer, worked out in the early 1960s, was **time-sharing**.\n\nThe idea is simple and clever: the computer switches between users so quickly — giving each a tiny slice of its attention in turn — that everyone *feels* like they have the machine to themselves. Researchers would sit at separate terminals, each typing away, while a single mainframe juggled all of them.\n\nThis is the first time the core shape of the cloud appears: **one powerful machine, shared by many, who each pay only for the slice they use.** Swap \"terminal in the next building\" for \"laptop on the internet\" and you have described cloud computing — sixty years early.",
        },
        {
          kind: "text",
          markdown:
            "## The idea that named it all: computing as a utility\n\nIn 1961, the computer scientist **John McCarthy** stood up at MIT's centennial celebration and said something that took fifty years to come true. Computing, he suggested, might one day be organised as a **public utility** — sold the same way we sell electricity or water.\n\nThink about what that means. You don't own a power station. You don't think about where your electricity comes from. You plug in, you use what you need, and you get a bill for exactly that. McCarthy imagined computing working the same way: a tap you turn on, power that just *appears*, and a bill based on usage.\n\nThat single image — **computing as a utility** — is the destination this entire course is travelling toward.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**Why a \"utility\" is the key idea.** A utility has three features worth remembering: you don't own the infrastructure, you don't maintain it, and you pay only for what you consume. Every step in the history of the cloud is really a step toward making computing behave exactly like that. When you reach the modern cloud at the end of this course, McCarthy's 1961 prediction will have come true almost word for word.",
        },
        {
          kind: "text",
          markdown:
            "## Why it couldn't happen yet\n\nIf the idea existed in 1961, why did the cloud take until the 2000s to arrive? Because the world was missing the one thing that makes a utility possible: **the wires to deliver it.**\n\nElectricity only became a utility once the power grid connected homes to distant power stations. Computing needed the same kind of grid — a fast, global, always-on network linking everyone to those distant machines. In 1961, that network didn't exist. Computers were islands.\n\nThe next lessons follow two threads that had to come together: computers getting smaller and spreading everywhere, and a network — the internet — growing up to connect them all.",
        },
      ],
      quiz: {
        passingScore: 70,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "In the 1950s and 60s, how did people typically get access to computing power?",
            choices: [
              { id: "a", label: "Everyone owned a small computer on their own desk" },
              {
                id: "b",
                label:
                  "An organisation owned a single room-sized mainframe that many people had to share",
              },
              { id: "c", label: "They rented virtual servers by the hour over the internet" },
              { id: "d", label: "They used containers managed by Kubernetes" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "mcq",
            promptMd:
              "What was **time-sharing**, the idea worked out in the early 1960s?",
            choices: [
              {
                id: "a",
                label:
                  "A single computer switching rapidly between many users, giving each a slice of attention so everyone feels they have it to themselves",
              },
              { id: "b", label: "Splitting the cost of a building between two universities" },
              { id: "c", label: "Scheduling computer use to off-peak hours to save electricity" },
              { id: "d", label: "Letting each user keep the machine for a full day in turn" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "In 1961, **John McCarthy** suggested computing might one day be organised like which everyday thing?",
            choices: [
              { id: "a", label: "A public utility, sold like electricity or water" },
              { id: "b", label: "A library book you borrow and return" },
              { id: "c", label: "A car you buy once and own for years" },
              { id: "d", label: "A television broadcast everyone receives at once" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "multi",
            promptMd:
              "According to the lesson, a **utility** has which defining features? Select all that apply.",
            choices: [
              { id: "a", label: "You don't own the infrastructure" },
              { id: "b", label: "You don't maintain it" },
              { id: "c", label: "You pay only for what you consume" },
              { id: "d", label: "You must buy it outright before you can use it" },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "tf",
            promptMd:
              "The lesson argues that McCarthy's utility idea couldn't become reality in 1961 because the fast, global, always-on **network** needed to deliver it did not yet exist.",
            correctValue: true,
          },
        ],
      },
    },
    {
      title: "The Personal Computer Detour",
      estMinutes: 7,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Computing got personal — and scattered\n\nThe shared-mainframe world didn't last. Starting in the late 1970s and exploding through the 80s and 90s, the **personal computer** put a machine on every desk. The Apple II, the IBM PC, and the wave of Windows machines that followed turned computing from something you queued for into something you owned outright.\n\nThis was a genuine revolution, and it was wonderful for people. But notice what it did to the *shape* of computing: it ran McCarthy's utility idea in reverse. Instead of one shared machine, suddenly there were millions of separate ones, each owned and maintained by its user. The grid hadn't arrived — everyone just bought their own generator.",
        },
        {
          kind: "text",
          markdown:
            "## Businesses ended up with server rooms\n\nFor an individual, a personal computer was liberating. For a *business*, the same pattern created a growing headache.\n\nA company didn't just need PCs for its staff. It needed **servers** — more powerful computers that run shared things: the email system, the company database, the website. And because there was still no utility to rent from, every company had to **buy and run its own servers**.\n\nSo businesses built **server rooms**: a closet or a floor full of humming machines that the company owned, powered, cooled, secured, and repaired. If you needed a new system, you bought a server, waited weeks for it to arrive, and installed it yourself.",
        },
        {
          kind: "text",
          markdown:
            "## The pain of owning your own servers\n\nRunning your own server room came with a chain of problems that should sound familiar from the very first lesson — because they're the same problems the mainframe age had, just spread across every company at once:\n\n- **A big up-front cost.** You paid for the whole machine before running a single program on it.\n- **You had to guess your peak.** You sized your servers for your busiest possible day — so most of the time, you were paying for capacity sitting idle.\n- **It needed constant care.** Power, cooling, security, and someone to notice when a hard drive failed at 3 a.m.\n- **It aged out.** Every few years the hardware became obsolete and you bought it all again.\n\nA company's computing was capped by the hardware it had physically bought. Growing meant buying more boxes and waiting.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "**This is the problem the cloud was invented to solve.** Hold onto this picture of the over-stuffed, half-idle, expensive server room — because it is the exact pain point that made the cloud irresistible the moment it became possible. Every benefit of the cloud is the mirror image of a problem on this list.",
        },
        {
          kind: "text",
          markdown:
            "## The missing piece arrives: the internet\n\nWhile every company was busy buying its own servers, the thing that would eventually rescue them was quietly growing up in the background: **the internet**.\n\nThe network that began as a research project in 1969 became, through the 1990s, a global public utility in its own right. The World Wide Web arrived. Ordinary homes and offices got online. For the first time, fast, reliable, always-on connections linked nearly everyone to nearly everywhere.\n\nThe grid McCarthy's utility needed had finally been built. Now someone just had to plug computing power into it.",
        },
      ],
      quiz: {
        passingScore: 70,
        questions: [
          {
            kind: "tf",
            promptMd:
              "By putting a separate machine on every desk, the personal-computer era ran McCarthy's shared-utility idea **in reverse** — millions of separate machines instead of one shared one.",
            correctValue: true,
          },
          {
            kind: "mcq",
            promptMd:
              "Why did businesses end up building their own **server rooms** in this era?",
            choices: [
              {
                id: "a",
                label:
                  "There was still no utility to rent from, so every company had to buy and run its own servers for shared systems like email and databases",
              },
              { id: "b", label: "Governments required every company to own servers" },
              { id: "c", label: "Cloud providers refused to sell to businesses" },
              { id: "d", label: "Personal computers could not connect to the internet at all" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "multi",
            promptMd:
              "Which of these were genuine pains of a business owning and running its own server room? Select all that apply.",
            choices: [
              { id: "a", label: "A big up-front cost before running a single program" },
              { id: "b", label: "Having to size servers for peak demand, leaving capacity idle most of the time" },
              { id: "c", label: "Constant care — power, cooling, security, and replacing failed hardware" },
              { id: "d", label: "Hardware that aged out every few years and had to be bought again" },
            ],
            correctChoiceIds: ["a", "b", "c", "d"],
          },
          {
            kind: "mcq",
            promptMd:
              "The lesson says a company's computing capacity was ultimately capped by what?",
            choices: [
              { id: "a", label: "The hardware it had physically bought" },
              { id: "b", label: "The number of employees it had" },
              { id: "c", label: "Government-imposed usage limits" },
              { id: "d", label: "The speed of its internet connection alone" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "Which development, growing in the background through the 1990s, finally supplied the 'grid' McCarthy's utility needed?",
            choices: [
              { id: "a", label: "The internet and the World Wide Web becoming a global public utility" },
              { id: "b", label: "The invention of the mainframe" },
              { id: "c", label: "The launch of Amazon Web Services" },
              { id: "d", label: "The release of Docker containers" },
            ],
            correctChoiceId: "a",
          },
        ],
      },
    },
    {
      title: "2006 — The Modern Cloud Is Born",
      estMinutes: 9,
      blocks: [
        {
          kind: "text",
          markdown:
            "## First, software you didn't install\n\nThe first crack in the \"own your own servers\" world came from a software company. In 1999, **Salesforce** launched with a then-radical pitch: business software you simply *use through your web browser*, with nothing to buy, install, or maintain. Their marketing even featured the word \"software\" with a red line through it.\n\nThis was the first taste of what we now call **Software as a Service** — software delivered over the internet as an ongoing service rather than a product in a box. You didn't run it; someone else did, and you just logged in. It proved that businesses would happily let a trusted provider run their software for them.",
        },
        {
          kind: "text",
          markdown:
            "## The breakthrough came from a bookseller\n\nThe truly transformative moment came from an unlikely place: **Amazon**, then known mostly for selling books online.\n\nTo run its giant store, Amazon had built enormous, sophisticated computing infrastructure — and its engineers realised two things. First, most of that capacity sat idle outside the holiday rush. Second, they had become genuinely *excellent* at running computers at scale. So Amazon asked a brilliant question: **what if we rented our spare computing power to anyone, over the internet, by the hour?**\n\nIn 2006, **Amazon Web Services (AWS)** launched the services that made this real — storage you could rent by the gigabyte, and virtual servers you could rent by the hour and switch off when done. McCarthy's utility had arrived, 45 years after he described it.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**Why 2006 is *the* date.** Plenty of ideas led up to it, but 2006 is when you could, for the first time, sit at a laptop, type in a credit card, and have a working server running minutes later — with no hardware purchased, no contract, and the ability to switch it off and stop paying whenever you liked. That combination — instant, self-service, pay-as-you-go computing over the internet — *is* the modern cloud.",
        },
        {
          kind: "text",
          markdown:
            "## The trick under the hood: virtualization\n\nHow can Amazon rent you \"a server\" in minutes when servers are physical machines that take weeks to buy? The answer is a technology called **virtualization**.\n\nVirtualization lets one powerful physical computer be sliced up into many independent **virtual** computers, each behaving like its own separate machine. Software does the slicing. So when you rent a server from the cloud, you're usually not getting a whole physical box — you're getting a virtual one, carved out of a big shared machine in a data centre, conjured into existence by software in seconds and dissolved just as fast when you're done.\n\nThis is the engine room of the cloud. It's what makes \"rent a computer by the minute\" physically possible.",
        },
        {
          kind: "text",
          markdown:
            "## Suddenly, anyone could build big\n\nIt's hard to overstate what this unlocked. Before 2006, launching an ambitious online product meant raising enough money to buy a room full of servers *before you had a single customer*. That barrier kept countless ideas from ever being tried.\n\nAfter 2006, a couple of people with a laptop and a credit card could rent world-class infrastructure for a few dollars, and — crucially — **scale it up instantly if their idea took off**. A startup could handle ten users or ten million using the same approach, paying only for what it actually used.\n\nThe businesses built on this idea — services that grew from a garage to millions of users in months — simply could not have existed in the old world. The cloud didn't just save money; it changed who was allowed to build.",
        },
      ],
      quiz: {
        passingScore: 70,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "Which 1999 company gave the first taste of **Software as a Service** — business software used through a browser with nothing to buy, install, or maintain?",
            choices: [
              { id: "a", label: "Salesforce" },
              { id: "b", label: "Amazon" },
              { id: "c", label: "Microsoft" },
              { id: "d", label: "Google" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "Which year and company are widely seen as marking the birth of the **modern cloud** — rentable storage and by-the-hour virtual servers over the internet?",
            choices: [
              { id: "a", label: "1999, Salesforce" },
              { id: "b", label: "2006, Amazon Web Services" },
              { id: "c", label: "2010, Microsoft Azure" },
              { id: "d", label: "2013, Docker" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "mcq",
            promptMd:
              "What insight led Amazon to launch AWS, according to the lesson?",
            choices: [
              {
                id: "a",
                label:
                  "Most of its computing capacity sat idle outside the holiday rush, and it had become excellent at running computers at scale — so it could rent that power out by the hour",
              },
              { id: "b", label: "Selling books online had stopped being profitable" },
              { id: "c", label: "The government asked it to provide a public computing utility" },
              { id: "d", label: "It wanted to stop using the internet for its store" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "What is **virtualization**, the technology that makes renting a server in minutes possible?",
            choices: [
              {
                id: "a",
                label:
                  "Slicing one powerful physical computer into many independent virtual computers, conjured and dissolved by software in seconds",
              },
              { id: "b", label: "Storing data in the form of video files" },
              { id: "c", label: "Connecting computers using virtual-reality headsets" },
              { id: "d", label: "Backing up a computer onto a second physical machine" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "tf",
            promptMd:
              "The lesson argues the cloud not only saved money but also **changed who was allowed to build**, because a small team with a laptop and credit card could rent world-class infrastructure and scale it instantly.",
            correctValue: true,
          },
        ],
      },
    },
    {
      title: "The Cloud Wars and the Three Layers",
      estMinutes: 8,
      blocks: [
        {
          kind: "video",
          url: "https://www.youtube.com/watch?v=XRdmfo4M_YA",
        },
        {
          kind: "text",
          markdown:
            "## The giants pile in\n\nAmazon had a head start, but it didn't stay alone for long. The other technology giants saw what was happening and raced to build their own clouds.\n\n- **Google** launched its cloud platform starting in 2008, leaning on the colossal infrastructure built for search.\n- **Microsoft** launched **Azure**, available to customers in 2010, built around the Microsoft tools that businesses already used everywhere.\n\nBy the mid-2010s the market had settled into a familiar shape — three dominant providers, often called the **Big Three**: Amazon's AWS, Microsoft Azure, and Google Cloud. They compete fiercely, which has driven prices down and capabilities up year after year.",
        },
        {
          kind: "text",
          markdown:
            "## Not all clouds are the same: three layers of service\n\nAs the cloud matured, it became clear that \"cloud\" actually means several different *levels* of service, depending on how much the provider handles versus how much you do. There are three classic layers, and the jargon is worth decoding once.\n\nThink of it like getting a meal:\n\n- **Infrastructure as a Service (IaaS)** — they give you the raw ingredients. You rent bare computing power and storage and build everything on top yourself. *Like buying groceries and cooking from scratch.*\n- **Platform as a Service (PaaS)** — they give you a ready kitchen. You bring just your own recipe (your code) and they handle the rest. *Like a meal kit.*\n- **Software as a Service (SaaS)** — they give you the finished meal. You just use the software; you manage nothing underneath. *Like ordering at a restaurant.*",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**A quick way to keep the three straight.** Ask: *how much is left for me to manage?* With IaaS, almost everything. With PaaS, just my own code. With SaaS, nothing at all — I only use it. The further down that list you go, the more the provider takes off your plate, and the less control you keep over the details. Salesforce, Gmail, and this LMS you're reading right now are all examples of SaaS.",
        },
        {
          kind: "text",
          markdown:
            "## The great shift: from owning to renting\n\nWith the layers and the providers in place, the 2010s saw a genuine change in how the business world thought about computing. The default flipped.\n\nFor decades, the question had been *\"which servers should we buy?\"* The new question became *\"why would we buy any servers at all?\"* Renting from the cloud turned a huge up-front purchase (capital expense) into a flexible monthly bill (operating expense), and it turned \"wait six weeks for hardware\" into \"have it in five minutes.\"\n\nCompanies began closing their server rooms and moving to the cloud in a wave often called **cloud migration**. The half-idle, expensive server room from Lesson 2 started, finally, to disappear.",
        },
        {
          kind: "text",
          markdown:
            "## What renting really buys you\n\nThe move to the cloud delivered the exact mirror image of every pain from the old server-room days:\n\n- **No big up-front cost** — you rent, paying as you go.\n- **Elasticity** — you scale *up* on your busy day and *down* afterwards, so you never pay for idle capacity you guessed you might need.\n- **Someone else's problem** — the provider handles power, cooling, security, failed drives, and ageing hardware.\n- **Speed** — new computing power appears in minutes, not weeks.\n\nThis word **elasticity** — growing and shrinking your computing to match real demand, minute by minute — is the single benefit that best captures why the cloud won.",
        },
      ],
      quiz: {
        passingScore: 70,
        questions: [
          {
            kind: "multi",
            promptMd:
              "By the mid-2010s the cloud market had settled into the **Big Three** providers. Which three are they? Select all that apply.",
            choices: [
              { id: "a", label: "Amazon Web Services (AWS)" },
              { id: "b", label: "Microsoft Azure" },
              { id: "c", label: "Google Cloud" },
              { id: "d", label: "Salesforce Cloud" },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "mcq",
            promptMd:
              "Which cloud layer leaves you managing **nothing** underneath — you simply use the finished software (like Gmail or this LMS)?",
            choices: [
              { id: "a", label: "Infrastructure as a Service (IaaS)" },
              { id: "b", label: "Platform as a Service (PaaS)" },
              { id: "c", label: "Software as a Service (SaaS)" },
              { id: "d", label: "Virtualization as a Service" },
            ],
            correctChoiceId: "c",
          },
          {
            kind: "mcq",
            promptMd:
              "Using the lesson's meal analogy, **Infrastructure as a Service (IaaS)** is most like which option?",
            choices: [
              { id: "a", label: "Buying groceries and cooking from scratch — they give you the raw ingredients" },
              { id: "b", label: "A meal kit — you bring just your recipe" },
              { id: "c", label: "Ordering the finished meal at a restaurant" },
              { id: "d", label: "Skipping the meal entirely" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "The 2010s wave of companies closing their server rooms and moving to the cloud is often called what?",
            choices: [
              { id: "a", label: "Cloud migration" },
              { id: "b", label: "Time-sharing" },
              { id: "c", label: "Virtualization" },
              { id: "d", label: "Orchestration" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "tf",
            promptMd:
              "**Elasticity** — growing and shrinking your computing to match real demand minute by minute — is named in the lesson as the single benefit that best captures why the cloud won.",
            correctValue: true,
          },
        ],
      },
    },
    {
      title: "The Cloud Today — and the Engine of the AI Age",
      estMinutes: 9,
      blocks: [
        {
          kind: "text",
          markdown:
            "## Smaller, faster, lighter: containers\n\nThe cloud didn't stop evolving once renting servers became normal. The next push was to make the units of computing *smaller and faster to move around*.\n\nThe big step was the **container**, popularised by a tool called **Docker** around 2013. A container packages a piece of software together with everything it needs to run, into one tidy, portable bundle. The famous promise: it runs *exactly* the same way on a developer's laptop as it does in the cloud, which kills off the age-old excuse, \"but it worked on my machine.\"\n\nContainers are lighter and quicker to start than full virtual servers, so applications could now be built from many small pieces that start in seconds and move effortlessly between machines.",
        },
        {
          kind: "text",
          markdown:
            "## Herding the containers: orchestration\n\nOnce an application is made of dozens — or thousands — of little containers, a new problem appears: *who keeps track of them all?* Who starts them, restarts the ones that crash, and adds more when traffic spikes?\n\nThe answer was **orchestration**, and the tool that came to dominate it is **Kubernetes**, which Google released to the world in 2014 based on its own internal systems. Kubernetes is, in effect, an automatic manager for a fleet of containers: you tell it what you want running, and it works tirelessly to make reality match, healing failures and scaling without a human in the loop.\n\nYou don't need to know how it works. Just know the trend: more and more of the manual babysitting of computers was being handed off to software.",
        },
        {
          kind: "text",
          markdown:
            "## The vanishing server: serverless\n\nThe logical end of that trend has a deliberately cheeky name: **serverless**. Launched in a popular form by AWS in 2014, serverless lets you run a piece of code *without thinking about servers at all*.\n\nThere are still servers, of course — the name is a joke. But you never see them, choose them, or manage them. You hand the cloud your code, it runs the moment something needs it, it scales automatically, and — the remarkable part — when nothing is happening, you **pay nothing**.\n\nThis is McCarthy's 1961 utility taken to its purest form. Like electricity, the computing is simply *there* when you flip the switch, invisible when you don't, and billed to the exact instant of use.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**The whole journey in one line.** From *buy a room full of machines and run them yourself* → to *rent a virtual machine by the hour* → to *just hand over your code and pay per use*. Each step removed more of what you had to own and manage. Sixty years on, computing finally behaves like the public utility it was first imagined to be in 1961.",
        },
        {
          kind: "text",
          markdown:
            "## Why none of today's AI exists without the cloud\n\nThere's a reason this history matters right now: **the current explosion in artificial intelligence is built directly on top of the cloud.**\n\nModern AI systems are trained on staggering amounts of data using staggering amounts of computing power — far more than any normal organisation could ever buy and house. The cloud is the only thing that makes it possible. A research team can summon thousands of specialised machines from a provider, use them intensively for a training run, and release them — paying only for that burst.\n\nThe elasticity, the pay-as-you-go model, the instant scale — every feature this course has traced was the necessary groundwork. The AI age is, in a very real sense, the cloud age finding its most demanding customer.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**Where you can see this for yourself.** This learning platform is a cloud application — it runs on rented cloud infrastructure, scales on demand, and its AI tutor calls AI models that themselves run in the cloud. Everything you've read about in this course is operating, right now, underneath the page you're reading it on.",
        },
      ],
      quiz: {
        passingScore: 70,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "What is a **container**, popularised by **Docker** around 2013?",
            choices: [
              {
                id: "a",
                label:
                  "Software packaged together with everything it needs to run, into one tidy, portable bundle that runs the same on a laptop as in the cloud",
              },
              { id: "b", label: "A physical shipping crate used to move servers between data centres" },
              { id: "c", label: "A type of mainframe from the 1960s" },
              { id: "d", label: "A backup copy of a hard drive" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "tf",
            promptMd:
              "Containers are generally **lighter and quicker to start** than full virtual servers.",
            correctValue: true,
          },
          {
            kind: "mcq",
            promptMd:
              "Once an application is made of dozens or thousands of containers, **orchestration** is needed to manage them. Which tool, released by Google in 2014, came to dominate orchestration?",
            choices: [
              { id: "a", label: "Kubernetes" },
              { id: "b", label: "Salesforce" },
              { id: "c", label: "ExpressRoute" },
              { id: "d", label: "Docker" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "What does **serverless** computing actually mean?",
            choices: [
              {
                id: "a",
                label:
                  "You hand the cloud your code; it runs the moment something needs it, scales automatically, and you pay nothing when nothing is happening — though servers still exist underneath",
              },
              { id: "b", label: "There are genuinely no servers involved anywhere" },
              { id: "c", label: "You must buy your own server to run the code" },
              { id: "d", label: "Code can only run on a personal computer, never in the cloud" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "Why does the lesson say today's AI boom is built directly on top of the cloud?",
            choices: [
              {
                id: "a",
                label:
                  "Modern AI needs more data and computing power than any normal organisation could buy and house — only the cloud's on-demand, pay-as-you-go scale makes a training run possible",
              },
              { id: "b", label: "AI was invented by cloud providers in 2006" },
              { id: "c", label: "The cloud stores all the world's books, which AI reads directly" },
              { id: "d", label: "AI can only run on personal computers, which the cloud replaced" },
            ],
            correctChoiceId: "a",
          },
        ],
      },
    },

    // ── Review & cumulative final exam ───────────────────────────────────
    {
      title: "Review & Final Exam",
      estMinutes: 20,
      blocks: [
        {
          kind: "text",
          markdown:
            "## You've travelled sixty years\n\nYou began with room-sized mainframes shared by a whole university, watched John McCarthy imagine computing as a public utility in 1961, saw the personal computer scatter computing into millions of private machines and server rooms, met the 2006 birth of the modern cloud, learned the three service layers and the Big Three providers, and finished with containers, orchestration, serverless, and the cloud as the engine of the AI age.\n\nThe whole arc, in one line: from *buy a room full of machines and run them yourself* → to *rent a virtual machine by the hour* → to *just hand over your code and pay per use*.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**This is a cumulative check.** The quiz below draws from **every** lesson in the course, mixed together in no particular order — just like a real review. You need **70%** to pass. If you miss a question, the explanation lives back in the lesson it came from; re-read that section and try again.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**One thread ties it all together.** Every milestone in this course is a step toward making computing behave like a **utility** — infrastructure you don't own, don't maintain, and pay for only as you use it. If a question stumps you, ask \"which step toward the utility does this describe?\" and the answer usually follows.",
        },
      ],
      quiz: {
        passingScore: 70,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "In 1961, **John McCarthy** predicted computing might one day be organised as a **public utility**. What did he mean?",
            choices: [
              {
                id: "a",
                label:
                  "Computing would be sold like electricity or water — you don't own or maintain it, and you pay only for what you use",
              },
              { id: "b", label: "The government would take over all computers" },
              { id: "c", label: "Every home would need its own power station to run a computer" },
              { id: "d", label: "Computers would become free for everyone forever" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "What was **time-sharing**, the 1960s idea that prefigured the cloud?",
            choices: [
              { id: "a", label: "Renting out your personal computer when you weren't using it" },
              {
                id: "b",
                label:
                  "A single powerful machine rapidly switching between many users, so each feels like they have it to themselves",
              },
              { id: "c", label: "Scheduling computer use to off-peak hours to save electricity" },
              { id: "d", label: "Two companies splitting the cost of one building" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "The rise of the **personal computer** in the 1980s and 90s moved computing *toward* the shared-utility model McCarthy imagined.",
            correctValue: false,
          },
          {
            kind: "multi",
            promptMd:
              "Which of these were genuine pains of a business owning and running its own server room? Select all that apply.",
            choices: [
              { id: "a", label: "A large up-front cost before running any software" },
              { id: "b", label: "Paying for peak capacity that sat idle most of the time" },
              { id: "c", label: "Constant maintenance — power, cooling, and replacing failed hardware" },
              { id: "d", label: "Hardware that became obsolete every few years and had to be re-bought" },
            ],
            correctChoiceIds: ["a", "b", "c", "d"],
          },
          {
            kind: "mcq",
            promptMd:
              "Which 1999 company first showed that businesses would let a provider run their software for them — software used through a browser with nothing to install?",
            choices: [
              { id: "a", label: "Salesforce" },
              { id: "b", label: "Amazon" },
              { id: "c", label: "Docker" },
              { id: "d", label: "Google" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "Which year and company are widely seen as marking the birth of the **modern cloud** — rentable storage and by-the-hour virtual servers over the internet?",
            choices: [
              { id: "a", label: "1999, Salesforce" },
              { id: "b", label: "2006, Amazon Web Services" },
              { id: "c", label: "2010, Microsoft Azure" },
              { id: "d", label: "2013, Docker" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "mcq",
            promptMd:
              "What is **virtualization**, the technology that makes renting a server in minutes possible?",
            choices: [
              {
                id: "a",
                label:
                  "Slicing one physical computer into many independent virtual computers, created and destroyed by software in seconds",
              },
              { id: "b", label: "Storing data in the form of video files" },
              { id: "c", label: "Connecting computers together with virtual-reality headsets" },
              { id: "d", label: "Backing up a computer to a second physical machine" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "By the mid-2010s, which three providers had become the **Big Three** of cloud computing?",
            choices: [
              { id: "a", label: "AWS, Microsoft Azure, and Google Cloud" },
              { id: "b", label: "Salesforce, Docker, and Kubernetes" },
              { id: "c", label: "IBM, Apple, and Salesforce" },
              { id: "d", label: "AWS, Salesforce, and Oracle" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "In the three layers of cloud service, which one leaves you managing **nothing** underneath — you simply use the finished software (like Gmail or this LMS)?",
            choices: [
              { id: "a", label: "Infrastructure as a Service (IaaS)" },
              { id: "b", label: "Platform as a Service (PaaS)" },
              { id: "c", label: "Software as a Service (SaaS)" },
              { id: "d", label: "Virtualization as a Service" },
            ],
            correctChoiceId: "c",
          },
          {
            kind: "mcq",
            promptMd:
              "Which technology, popularised by **Docker** around 2013, packages software with everything it needs into one portable bundle that runs the same on a laptop as in the cloud?",
            choices: [
              { id: "a", label: "The container" },
              { id: "b", label: "The mainframe" },
              { id: "c", label: "The availability zone" },
              { id: "d", label: "Time-sharing" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "tf",
            promptMd:
              "\"**Serverless**\" computing means there are genuinely no servers involved anywhere.",
            correctValue: false,
          },
          {
            kind: "multi",
            promptMd:
              "Renting from the cloud reversed the pains of the old server room. Which benefits did it deliver? Select all that apply.",
            choices: [
              { id: "a", label: "No large up-front cost — you pay as you go" },
              { id: "b", label: "Elasticity — scale up on busy days and down afterwards" },
              { id: "c", label: "The provider handles power, cooling, security, and failed hardware" },
              { id: "d", label: "New computing power available in minutes instead of weeks" },
            ],
            correctChoiceIds: ["a", "b", "c", "d"],
          },
        ],
      },
    },
  ],
};

export default course;
