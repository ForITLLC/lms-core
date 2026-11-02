import type { CourseSeed } from "@/db/seed/course-seed";

const course: CourseSeed = {
  slug: "history-of-ai",
  title: "A History of Artificial Intelligence",
  description:
    "The 80-year story of teaching machines to think — from Alan Turing's 1950 question through two long \"AI winters\" to the deep-learning breakthrough and the generative AI you use today. Plain-language, no maths, no coding; just how we got from a bold idea to ChatGPT.",
  category: "engineering",
  mandatory: false,
  tags: [
    "history",
    "ai",
    "artificial-intelligence",
    "machine-learning",
    "deep-learning",
    "general-knowledge",
  ],
  lessons: [
    {
      title: "Can a Machine Think?",
      estMinutes: 8,
      blocks: [
        {
          kind: "text",
          markdown:
            "## A question older than the computer\n\nThe dream of a thinking machine is ancient — it runs through myth and fiction long before any real computer existed. But it became a *serious scientific question* in 1950, asked by one of the most important figures in the history of computing: the British mathematician **Alan Turing**.\n\nTuring had helped invent the very idea of the computer. Now he asked something deeper, in a famous paper that opened with five plain words: **\"Can machines think?\"** He suspected the question was too vague to answer directly — so he reframed it into something you could actually test.",
        },
        {
          kind: "text",
          markdown:
            "## The Turing Test\n\nInstead of arguing about what \"think\" means, Turing proposed a game. A human judge holds a text conversation with two hidden partners — one a person, one a machine — and tries to work out which is which. If the judge can't reliably tell the machine from the human, Turing argued, then in any practical sense the machine is *thinking*.\n\nThis became known as the **Turing Test**, and it was a brilliant sidestep. It replaced an unanswerable philosophical debate with a concrete, observable challenge: not \"is the machine truly conscious?\" but \"can it behave indistinguishably from someone who is?\"\n\nThe Turing Test set the target the whole field would chase for decades — and it's worth noting that today's best AI systems can hold conversations Turing could only imagine.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**Why the Turing Test mattered so much.** It made the dream *measurable*. A field can't make progress toward a goal it can't define, and Turing gave the emerging field of AI a clear finish line it could point at and argue about. Whether the test is the *right* measure is still debated — but it gave everyone something concrete to aim for, which is exactly what a young science needs.",
        },
        {
          kind: "text",
          markdown:
            "## 1956: the field gets its name\n\nIf 1950 posed the question, 1956 founded the field. That summer, a small group of researchers gathered at **Dartmouth College** in the United States for a workshop that would define a discipline.\n\nIt was there that the organiser, **John McCarthy**, coined the term that stuck: **artificial intelligence**. (This is the same John McCarthy who, five years later, would predict computing-as-a-utility — the man helped name two revolutions.) The Dartmouth group set out a breathtakingly confident goal: that every aspect of human intelligence could, in principle, be described so precisely that a machine could be made to simulate it.\n\nThe field of AI was officially born — and born with enormous optimism.",
        },
        {
          kind: "text",
          markdown:
            "## The bold early promises\n\nThe founders weren't shy. Through the late 1950s and 60s, leading researchers made startling predictions: that within a generation, machines would do any work a human could do; that a computer would be world chess champion within ten years; that the problem of artificial intelligence would be substantially solved in a single summer of focused effort.\n\nThere were real, exciting early results to fuel this. Programs were written that could prove mathematical theorems and solve logic puzzles. It genuinely looked like thinking machines were just around the corner.\n\nThey were not. That gap — between bold promise and stubborn reality — is the rhythm that beats through the rest of this story.",
        },
      ],
      quiz: {
        passingScore: 70,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "In his 1950 paper, **Alan Turing** opened with which famous question?",
            choices: [
              { id: "a", label: "\"Can machines think?\"" },
              { id: "b", label: "\"How fast can a computer add numbers?\"" },
              { id: "c", label: "\"Will robots take our jobs?\"" },
              { id: "d", label: "\"What is the meaning of intelligence?\"" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "Rather than argue about what \"think\" means, the **Turing Test** judges a machine by which standard?",
            choices: [
              {
                id: "a",
                label:
                  "Whether a human judge in a text conversation can reliably tell the machine from a person",
              },
              { id: "b", label: "Whether the machine is provably conscious" },
              { id: "c", label: "How quickly the machine solves arithmetic" },
              { id: "d", label: "How much memory the machine has" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "Who coined the term **\"artificial intelligence\"** at the 1956 Dartmouth College workshop?",
            choices: [
              { id: "a", label: "Alan Turing" },
              { id: "b", label: "John McCarthy" },
              { id: "c", label: "Garry Kasparov" },
              { id: "d", label: "Geoffrey Hinton" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "tf",
            promptMd:
              "Turing reframed the vague question \"Can machines think?\" into a concrete, observable challenge because he believed the original question was too vague to answer directly.",
            correctValue: true,
          },
          {
            kind: "multi",
            promptMd:
              "Which of these describe the **early mood and promises** of the field after 1956? Select all that apply.",
            choices: [
              { id: "a", label: "Enormous optimism about what machines would soon do" },
              { id: "b", label: "Predictions that a computer would soon be world chess champion" },
              { id: "c", label: "Early programs that could prove theorems and solve logic puzzles" },
              { id: "d", label: "An immediate, cautious admission that thinking machines were centuries away" },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
        ],
      },
    },
    {
      title: "Rules, Reasoning, and the First Winter",
      estMinutes: 8,
      blocks: [
        {
          kind: "text",
          markdown:
            "## The first big idea: intelligence as rules\n\nThe earliest approach to AI rested on an appealing assumption: that thinking is essentially **following logical rules**. If you could write down enough rules and facts about the world, and give a computer a way to reason through them, you'd get intelligence.\n\nThis approach — sometimes called **symbolic AI**, because it manipulates symbols and rules the way a logician would — dominated the field's first few decades. The dream was that a human expert's knowledge could be captured as a giant rulebook: *if this is true, then conclude that.* Feed in a problem, and the machine grinds through its rules to an answer.\n\nFor neat, well-defined problems like chess or logic puzzles, this worked impressively well.",
        },
        {
          kind: "text",
          markdown:
            "## Where rules fall apart\n\nThe trouble is that most of life isn't a neat, well-defined problem. Think about recognising a friend's face, understanding a joke, or knowing that a cup of coffee shouldn't be poured into a laptop. None of that comes from consciously following rules — it comes from vast, fuzzy, mostly-unspoken common sense.\n\nTry to write that down as rules and the rulebook explodes. For every rule, there's an exception; for every exception, an exception to the exception. The real world is messy, ambiguous, and endless. The symbolic approach kept hitting the same wall: it could be brilliant in a narrow, tidy domain and utterly helpless the moment it stepped outside one.",
        },
        {
          kind: "text",
          markdown:
            "## The first AI winter\n\nBy the early 1970s, the gap between the grand promises and the modest reality had become impossible to ignore. The machines of the day were also simply too slow and too small in memory to do what researchers hoped.\n\nDisappointed funders — including governments that had poured money in expecting miracles — began pulling their support. An influential and skeptical UK report in 1973 helped trigger deep cuts. Research money dried up, labs shrank, and the field entered a long, cold stretch that came to be called the **first AI winter**.\n\nThe dream wasn't dead. But it had badly overpromised, and it paid the price.",
        },
        {
          kind: "callout",
          variant: "warning",
          markdown:
            "**The pattern to watch: hype, then winter.** AI's history runs in cycles. A burst of progress sparks wild excitement and big promises; the promises outrun what the technology can actually deliver; disappointed money flees; and the field freezes over. You're about to see this happen a *second* time. Recognising the rhythm helps you read today's AI moment with clearer eyes — knowing which past mistakes are, and aren't, being repeated.",
        },
        {
          kind: "text",
          markdown:
            "## Why the early approach was doomed to stall\n\nLooking back, the deepest reason symbolic AI hit a ceiling is this: **the people writing the rules had to understand and spell out, in advance, every scrap of knowledge the machine would use.**\n\nBut human experts often *can't* explain how they know things. A doctor recognises an illness, a driver senses a dangerous road, you recognise your mother's voice in an instant — none of you could write the rulebook for how. Knowledge that can't be put into words can't be programmed in as rules.\n\nThe field would eventually escape this trap with a radically different idea: instead of *telling* the machine the rules, what if you could let it *learn* them for itself? But that breakthrough was still decades away. First came one more boom and bust.",
        },
      ],
      quiz: {
        passingScore: 70,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "The earliest approach to AI, called **symbolic AI**, was built on which assumption?",
            choices: [
              { id: "a", label: "That thinking is essentially following logical rules and facts" },
              { id: "b", label: "That machines should learn patterns from millions of examples" },
              { id: "c", label: "That the brain works by stacking neural networks many layers deep" },
              { id: "d", label: "That intelligence requires the internet" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "Symbolic AI worked impressively on some problems but failed on others. Where did it tend to **succeed**?",
            choices: [
              { id: "a", label: "Neat, well-defined domains like chess and logic puzzles" },
              { id: "b", label: "Recognising faces and understanding jokes" },
              { id: "c", label: "Fuzzy common-sense reasoning about the everyday world" },
              { id: "d", label: "Generating original images and audio" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "What is the deepest reason the rules-based approach hit a ceiling?",
            choices: [
              {
                id: "a",
                label:
                  "Humans had to spell out every scrap of knowledge in advance, but much expert knowledge can't be put into words",
              },
              { id: "b", label: "Computers had become far too fast and powerful" },
              { id: "c", label: "There were too few logicians available to write rules" },
              { id: "d", label: "Governments banned the manipulation of symbols" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "tf",
            promptMd:
              "By the early 1970s, disappointed funders pulled their support and the field entered a long, cold stretch that came to be called the **first AI winter**.",
            correctValue: true,
          },
          {
            kind: "multi",
            promptMd:
              "Which factors contributed to the **first AI winter**? Select all that apply.",
            choices: [
              { id: "a", label: "The gap between grand promises and modest results became impossible to ignore" },
              { id: "b", label: "The machines of the day were too slow and too small in memory" },
              { id: "c", label: "A skeptical UK report helped trigger deep funding cuts" },
              { id: "d", label: "ChatGPT had made the approach obsolete" },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
        ],
      },
    },
    {
      title: "Expert Systems, a Second Winter, and a Quiet Turn",
      estMinutes: 8,
      blocks: [
        {
          kind: "text",
          markdown:
            "## The 1980s comeback: expert systems\n\nAI thawed and came roaring back in the 1980s, this time with a commercial product businesses would actually pay for: the **expert system**.\n\nAn expert system was a focused, practical application of the old rules-based idea. Rather than trying to build general intelligence, you'd capture the knowledge of a *specific* human expert — a doctor diagnosing infections, an engineer configuring computer orders — into a tight rulebook for that one narrow job. And within those narrow jobs, they worked. Companies built them, sold them, and saved real money.\n\nFor a while, AI was a booming industry again. A whole market grew up around it, including specialised computers built just to run these systems.",
        },
        {
          kind: "text",
          markdown:
            "## The second winter\n\nThen the same crack reappeared. Expert systems were expensive to build, painful to keep up to date, and brittle: step even slightly outside the narrow box they were built for and they failed, often without any sign they'd gone wrong.\n\nThey couldn't learn, couldn't adapt, and couldn't handle the messy edges of the real world — the very same limits that had ended the first boom. As cheaper, general-purpose computers also undercut the specialised AI machines, the market collapsed. By the late 1980s and into the 90s, the field froze over again in a **second AI winter**.\n\nTwice now, the rules-based dream had risen and fallen on exactly the same flaw.",
        },
        {
          kind: "text",
          markdown:
            "## A quiet shift: let the machine learn\n\nDuring and after that second winter, away from the hype, a different idea was steadily maturing — the one that would eventually change everything. Instead of a human painstakingly writing rules, what if the computer could **learn patterns directly from examples?**\n\nThis approach is called **machine learning**. The principle is a genuine reversal of everything before it: you don't tell the machine *how* to recognise a cat. You show it thousands of pictures labelled \"cat\" and \"not cat,\" and the machine works out the pattern *for itself*. Show it enough examples and it gets startlingly good — without anyone ever writing a single rule about whiskers or fur.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**This is the hinge of the whole story.** Old way: a human writes the rules, the machine follows them. New way: the human provides examples, and the machine learns the rules itself. That flip — from *programming* knowledge in to *learning* it from data — is what finally broke through the wall that stopped AI twice. Almost everything you hear about AI today, from photo tagging to ChatGPT, sits on this single idea.",
        },
        {
          kind: "text",
          markdown:
            "## A symbolic farewell: Deep Blue, 1997\n\nThe transition era had a famous landmark. In 1997, IBM's chess computer **Deep Blue** defeated the reigning world champion, Garry Kasparov — the first time a machine beat the best human alive at chess under tournament conditions. It made headlines around the world.\n\nIt's a fascinating hinge moment. Deep Blue won mostly through brute-force calculation and chess rules hand-crafted by experts — in many ways the *last great triumph of the old, rules-based approach* rather than the dawn of the new one. It proved a machine could surpass humans at a hard, narrow task. The question that remained was how to do it *without* an army of experts writing the rules — and the answer, machine learning, was about to arrive at full force.",
        },
      ],
      quiz: {
        passingScore: 70,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "The 1980s AI comeback was driven by a commercial product called the **expert system**. What was it?",
            choices: [
              {
                id: "a",
                label:
                  "A focused rulebook capturing one specific human expert's knowledge for one narrow job",
              },
              { id: "b", label: "A neural network that learned from millions of photos" },
              { id: "c", label: "A chat window anyone could talk to" },
              { id: "d", label: "A general intelligence that could do any human task" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "multi",
            promptMd:
              "Why did expert systems collapse, leading to the **second AI winter**? Select all that apply.",
            choices: [
              { id: "a", label: "They were expensive to build and painful to keep up to date" },
              { id: "b", label: "They were brittle and failed the moment they stepped outside their narrow box" },
              { id: "c", label: "Cheaper general-purpose computers undercut the specialised AI machines" },
              { id: "d", label: "They learned and adapted too well, frightening their makers" },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
          {
            kind: "mcq",
            promptMd:
              "**Machine learning** was the quiet idea maturing during the second winter. What makes it a reversal of everything before it?",
            choices: [
              {
                id: "a",
                label:
                  "Instead of a human writing rules, the machine works out the pattern itself from labelled examples",
              },
              { id: "b", label: "It uses faster rules written by even more experts" },
              { id: "c", label: "It only works on board games" },
              { id: "d", label: "It requires no data at all" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "How did IBM's **Deep Blue** beat Garry Kasparov at chess in 1997?",
            choices: [
              {
                id: "a",
                label:
                  "Mostly through brute-force calculation and chess rules hand-crafted by experts — the last great triumph of the old, rules-based approach",
              },
              { id: "b", label: "By learning its own strategy from millions of self-played games" },
              { id: "c", label: "By using a large language model trained on the internet" },
              { id: "d", label: "By copying moves from a database of every game ever played online" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "tf",
            promptMd:
              "Twice — in the first winter and again with expert systems — the rules-based dream rose and fell on essentially the same flaw: it couldn't learn, adapt, or handle the messy edges of the real world.",
            correctValue: true,
          },
        ],
      },
    },
    {
      title: "The Deep Learning Revolution",
      estMinutes: 8,
      blocks: [
        {
          kind: "text",
          markdown:
            "## An old idea finally gets its moment\n\nThe technique that finally cracked things open was, ironically, one of the oldest ideas in AI: the **neural network**, loosely inspired by how brain cells connect. The concept dated back to the 1950s but had never lived up to its promise — it had even been written off as a dead end.\n\nWhat changed wasn't mainly the idea. It was that the world finally had the two things the idea had always been starving for. Stacking these networks many layers deep — which gives the approach its modern name, **deep learning** — suddenly became practical. The drought was over because two key ingredients had finally arrived together.",
        },
        {
          kind: "text",
          markdown:
            "## The two missing ingredients: data and power\n\nMachine learning lives on examples — and by the late 2000s, two things it had always lacked were suddenly abundant.\n\n- **Data.** The internet had created an ocean of it: billions of photos, pages, and videos. The endless labelled examples a learning machine needs to study were, at last, just *there*.\n- **Computing power.** It turned out that a kind of chip built for video-game graphics — the **GPU** — happened to be brilliant at the exact calculations neural networks need. (And the cloud, the subject of this course's companion, made vast amounts of that power rentable on demand.)\n\nThe idea had been waiting decades for the data and the horsepower to catch up. Around 2010, they both did.",
        },
        {
          kind: "text",
          markdown:
            "## 2012: the breakthrough moment\n\nThe field has a clear \"before and after\" moment, and it's 2012. Each year, researchers competed to see whose software could best recognise the contents of photographs — a famously hard test of real-world perception.\n\nIn 2012, a deep-learning system (later known as **AlexNet**, built by a team including researchers who'd kept faith in neural networks through the lean years) didn't just win — it *crushed* the competition, leaping past every rules-based and traditional approach by a stunning margin. The message was unmistakable: deep learning didn't just work, it worked *dramatically better* than anything else.\n\nIt set off a stampede. Within a few years, deep learning was powering photo tagging, voice assistants, translation, and recommendations — quietly threaded through technology millions of people used every day.",
        },
        {
          kind: "text",
          markdown:
            "## 2016: a machine masters intuition\n\nIf 1997's Deep Blue was the old way's swan song, 2016 was the new way's triumph. A system called **AlphaGo**, from the lab DeepMind, beat one of the world's top players at **Go** — an ancient board game so vast and intuitive that experts had long believed it was decades beyond any machine.\n\nThe contrast with Deep Blue is the whole point. Go can't be won by brute-force calculation; there are more possible games than atoms in the universe. AlphaGo won by *learning* — studying countless games and then playing millions against itself to develop something that looked uncannily like intuition. At one point it played a move so creative and strange that commentators thought it was a mistake; it turned out to be brilliant.\n\nThis was no longer a machine following human rules. It was a machine discovering things humans hadn't.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**The shift in one comparison.** Deep Blue (1997) beat humans at chess by calculating faster within rules people gave it. AlphaGo (2016) beat humans at Go by *learning* its own strategy from experience — and inventing moves no human had taught it. The first is a powerful calculator. The second is something genuinely new. That leap, from calculation to learning, is what makes modern AI feel different from everything that came before.",
        },
      ],
      quiz: {
        passingScore: 70,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "The technique that finally cracked things open was an old idea: the **neural network**. What is it loosely inspired by?",
            choices: [
              { id: "a", label: "How brain cells connect" },
              { id: "b", label: "How a logician follows rules" },
              { id: "c", label: "How the internet routes traffic" },
              { id: "d", label: "How a chess grandmaster memorises openings" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "Stacking neural networks **many layers deep** gives the modern approach its name. What is that name?",
            choices: [
              { id: "a", label: "Deep learning" },
              { id: "b", label: "Symbolic AI" },
              { id: "c", label: "Expert systems" },
              { id: "d", label: "The Turing Test" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "multi",
            promptMd:
              "Around 2010, deep learning finally took off because two long-missing ingredients became abundant. Which two? Select all that apply.",
            choices: [
              { id: "a", label: "Enormous amounts of data, thanks to the internet" },
              { id: "b", label: "Powerful computing, especially GPUs originally built for graphics" },
              { id: "c", label: "A revival of hand-written expert rulebooks" },
              { id: "d", label: "Stricter government regulation of computers" },
            ],
            correctChoiceIds: ["a", "b"],
          },
          {
            kind: "mcq",
            promptMd:
              "What happened in **2012**, the field's clear \"before and after\" moment?",
            choices: [
              {
                id: "a",
                label:
                  "A deep-learning system (AlexNet) crushed the competition at recognising the contents of photographs",
              },
              { id: "b", label: "IBM's Deep Blue beat the world chess champion" },
              { id: "c", label: "ChatGPT reached a hundred million users" },
              { id: "d", label: "The term \"artificial intelligence\" was coined" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "How did **AlphaGo** (2016) win at Go, and why couldn't it have used Deep Blue's brute-force method?",
            choices: [
              {
                id: "a",
                label:
                  "It learned its own strategy by playing millions of games against itself, because Go has more possible games than atoms in the universe",
              },
              { id: "b", label: "It followed a complete rulebook written by Go grandmasters" },
              { id: "c", label: "It simply calculated every possible game to the end" },
              { id: "d", label: "It copied AlexNet's winning photo-recognition code" },
            ],
            correctChoiceId: "a",
          },
        ],
      },
    },
    {
      title: "Transformers and the Generative Age",
      estMinutes: 9,
      blocks: [
        {
          kind: "video",
          url: "https://www.youtube.com/watch?v=wjZofJX0v4M",
        },
        {
          kind: "text",
          markdown:
            "## 2017: the invention that lit the fuse\n\nDeep learning was winning at images and games, but *language* — the messy, ambiguous, deeply human thing — remained stubborn. Then in 2017, researchers published a new design for neural networks called the **Transformer**.\n\nYou don't need the mechanics. The breakthrough was that the Transformer was remarkably good at handling sequences like sentences — at paying *attention* to how each word relates to all the others, and so grasping context and meaning. Crucially, it was also far better at soaking up enormous amounts of training efficiently, which meant it could be fed almost the entire writable internet.\n\nNearly every AI system making headlines today — and the AI tutor inside this learning platform — is built on the Transformer. 2017 is the year the modern era quietly began.",
        },
        {
          kind: "text",
          markdown:
            "## Large language models\n\nFeed a Transformer a colossal amount of text — books, articles, websites, conversations — and train it on a deceptively simple task: *predict the next word.* Do that at vast enough scale and something remarkable emerges. The result is a **large language model**, or **LLM**.\n\nIn learning to predict the next word across nearly all human writing, these models absorb grammar, facts, reasoning patterns, writing styles, and a startling amount of how the world works. They can write, summarise, translate, answer questions, and explain ideas — not by following rules anyone wrote, but as a side effect of having learned the deep patterns of language itself.\n\nThe progression had a clear logic: bigger models, trained on more text with more computing power, kept getting *qualitatively* more capable — often in ways that surprised even their creators.",
        },
        {
          kind: "text",
          markdown:
            "## November 2022: AI meets everyone\n\nFor years this progress lived mostly inside research labs and tech companies. That changed almost overnight in late 2022, when a large language model was wrapped in a simple chat window that anyone could just *talk to* — **ChatGPT**.\n\nThe effect was extraordinary. It became one of the fastest-adopted products in history, reaching a hundred million users in a matter of weeks. For the first time, the general public could hold a fluent conversation with an AI, ask it to write an email or explain a concept, and watch it respond like a knowledgeable, articulate person.\n\nThe technology hadn't appeared from nowhere — it was the direct descendant of everything in this course. But the *access* was new, and it changed the public conversation about AI overnight.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**\"Generative\" AI, in plain terms.** Earlier AI mostly *classified* things — is this a cat or a dog, spam or not. The new wave **generates** things: original text, images, code, audio. That's why it's called *generative* AI. It doesn't just sort the world into bins; it produces new work. That single shift — from labelling things to creating them — is what makes today's AI feel less like a tool and more like a collaborator.",
        },
        {
          kind: "text",
          markdown:
            "## Where we stand — and the lesson of the winters\n\nSo here we are. In about seventy years, AI travelled from a question on a page to a system you can have a real conversation with — passing through two boom-and-bust winters along the way. The whole arc bends around one idea: progress stalled for decades while we tried to *program* intelligence with rules, and accelerated the moment we let machines *learn* it from data.\n\nIt's worth holding the history's central caution in mind. Each past surge of excitement was followed by a winter when the promises outran reality. Today's AI is genuinely, dramatically more capable than anything before it — but the field has been *certain* the finish line was near twice before, and been wrong both times.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**Seeing this history in action.** The AI tutor built into this learning platform is a generative large language model, descended directly from the Transformer breakthrough of 2017. Every concept in this final lesson is running, right now, the moment you ask that tutor a question. If you'd like to understand how an AI like that gets put to work safely inside real business tools, the companion course *AI at Work* is the natural next step.",
        },
      ],
      quiz: {
        passingScore: 75,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "What was the **Turing Test**, proposed by Alan Turing in 1950?",
            choices: [
              {
                id: "a",
                label:
                  "If a human judge in a text conversation can't reliably tell a machine from a person, the machine counts as thinking",
              },
              { id: "b", label: "A test of how fast a computer can do arithmetic" },
              { id: "c", label: "A way to measure a computer's memory capacity" },
              { id: "d", label: "A chess match between a human and a machine" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "At which 1956 event was the term **\"artificial intelligence\"** coined, founding the field?",
            choices: [
              { id: "a", label: "The launch of the first IBM mainframe" },
              { id: "b", label: "The Dartmouth College workshop" },
              { id: "c", label: "The release of the first personal computer" },
              { id: "d", label: "The Deep Blue chess match" },
            ],
            correctChoiceId: "b",
          },
          {
            kind: "mcq",
            promptMd:
              "Early AI used a **symbolic** (rules-based) approach. What was its fundamental limitation?",
            choices: [
              {
                id: "a",
                label:
                  "Humans had to spell out every rule in advance, but most real-world knowledge is fuzzy and can't be written down as rules",
              },
              { id: "b", label: "It required the internet, which didn't exist yet" },
              { id: "c", label: "It could only run on personal computers" },
              { id: "d", label: "It was illegal in most countries" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "tf",
            promptMd:
              "The history of AI includes two long \"winters\" — periods when overblown promises outran reality and funding and interest collapsed.",
            correctValue: true,
          },
          {
            kind: "mcq",
            promptMd:
              "**Machine learning** reversed the old approach to AI. What is the core difference?",
            choices: [
              {
                id: "a",
                label:
                  "Instead of a human writing the rules, the machine learns patterns for itself from many examples",
              },
              { id: "b", label: "It uses faster rules written by more experts" },
              { id: "c", label: "It only works on board games like chess and Go" },
              { id: "d", label: "It stores rules in the cloud instead of on a local machine" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "multi",
            promptMd:
              "Around 2010, deep learning finally took off because two things it had long lacked became abundant. Which two? Select all that apply.",
            choices: [
              { id: "a", label: "Enormous amounts of data, thanks to the internet" },
              { id: "b", label: "Powerful computing, especially GPUs originally built for graphics" },
              { id: "c", label: "Stricter government regulation of computers" },
              { id: "d", label: "A return to hand-written expert rules" },
            ],
            correctChoiceIds: ["a", "b"],
          },
          {
            kind: "mcq",
            promptMd:
              "How did **AlphaGo** (2016) differ from **Deep Blue** (1997) in how it beat human champions?",
            choices: [
              {
                id: "a",
                label:
                  "Deep Blue won by brute-force calculation within human-given rules; AlphaGo won by learning its own strategy from experience",
              },
              { id: "b", label: "AlphaGo played chess while Deep Blue played Go" },
              { id: "c", label: "Deep Blue learned from data; AlphaGo followed hand-written rules" },
              { id: "d", label: "There was no real difference — both used the same method" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "The 2017 invention that underpins almost all of today's headline AI — including large language models — is called the:",
            choices: [
              { id: "a", label: "Transformer" },
              { id: "b", label: "Expert system" },
              { id: "c", label: "Mainframe" },
              { id: "d", label: "Turing machine" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "tf",
            promptMd:
              "A large language model (LLM) is trained largely by learning to predict the next word across vast amounts of text, and picks up grammar, facts, and reasoning as a side effect.",
            correctValue: true,
          },
          {
            kind: "mcq",
            promptMd:
              "What does it mean that today's wave of AI is **generative**?",
            choices: [
              {
                id: "a",
                label:
                  "It produces new original work — text, images, code, audio — rather than only sorting things into categories",
              },
              { id: "b", label: "It generates electricity to power the cloud" },
              { id: "c", label: "It only works on the first generation of computers" },
              { id: "d", label: "It can run without any data or training" },
            ],
            correctChoiceId: "a",
          },
        ],
      },
    },
    {
      title: "Review & Final Exam",
      estMinutes: 18,
      blocks: [
        {
          kind: "text",
          markdown:
            "## The whole arc in one breath\n\nIn roughly seventy years, AI travelled from a question on a page to a system you can hold a conversation with. Trace the line: **Turing's 1950 question** and the **1956 Dartmouth** christening → the **rules-based (symbolic)** era and its **first winter** → the **expert-system** boom and the **second winter** → the quiet rise of **machine learning** → the **deep-learning** breakthrough (data + GPUs, AlexNet in 2012, AlphaGo in 2016) → the **Transformer** of 2017, **large language models**, and **ChatGPT** in 2022.\n\nThe whole story bends around a single idea: progress stalled for decades while we tried to *program* intelligence with rules, and accelerated the moment we let machines *learn* it from data.",
        },
        {
          kind: "callout",
          variant: "info",
          markdown:
            "**This is a cumulative check.** The questions below are drawn from across all five lessons, in mixed order — just like a real final exam. You need **70%** to pass. If you miss one, the explanation lives back in the matching lesson above; reread it and try again. Two long \"winters\" taught the field humility, so don't rush — read each question fully before answering.",
        },
        {
          kind: "callout",
          variant: "tip",
          markdown:
            "**One thread to hold onto.** Almost every turning point in this course is a variation on the same hinge: *rules written by humans* versus *patterns learned from data*. If a question stumps you, ask which side of that line it sits on — it usually points straight at the answer.",
        },
      ],
      quiz: {
        passingScore: 70,
        questions: [
          {
            kind: "mcq",
            promptMd:
              "What did the **Turing Test** (1950) propose as the practical test of a thinking machine?",
            choices: [
              {
                id: "a",
                label:
                  "If a human judge in a text conversation can't reliably tell the machine from a person, it counts as thinking",
              },
              { id: "b", label: "Whether the machine can prove it is conscious" },
              { id: "c", label: "How many calculations per second the machine performs" },
              { id: "d", label: "Whether the machine can beat a grandmaster at chess" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "The field of AI got its name and its founding goal at which 1956 event?",
            choices: [
              { id: "a", label: "The Dartmouth College workshop" },
              { id: "b", label: "The Deep Blue chess match" },
              { id: "c", label: "The launch of ChatGPT" },
              { id: "d", label: "The first ImageNet competition" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "**Symbolic (rules-based) AI** dominated the early decades. What was its fundamental flaw?",
            choices: [
              {
                id: "a",
                label:
                  "Humans had to spell out every rule in advance, but most real-world knowledge is fuzzy and can't be written down",
              },
              { id: "b", label: "It needed GPUs, which hadn't been invented" },
              { id: "c", label: "It could only run in the cloud" },
              { id: "d", label: "It learned too fast for anyone to control" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "tf",
            promptMd:
              "The history of AI includes **two** long \"winters\" — periods when overblown promises outran reality and funding collapsed.",
            correctValue: true,
          },
          {
            kind: "mcq",
            promptMd:
              "The 1980s **expert system** was best described as:",
            choices: [
              {
                id: "a",
                label:
                  "A focused rulebook capturing one specific expert's knowledge for one narrow job",
              },
              { id: "b", label: "A general intelligence able to do any human task" },
              { id: "c", label: "A neural network trained on internet-scale data" },
              { id: "d", label: "A chat window the public could talk to" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "**Machine learning** reversed the old approach. What is the core difference?",
            choices: [
              {
                id: "a",
                label:
                  "The human provides labelled examples and the machine learns the pattern itself, instead of a human writing the rules",
              },
              { id: "b", label: "It uses faster rules written by more experts" },
              { id: "c", label: "It stores its rules in the cloud instead of locally" },
              { id: "d", label: "It only works on chess and Go" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "How did **Deep Blue** (1997) beat the world chess champion?",
            choices: [
              {
                id: "a",
                label:
                  "Through brute-force calculation and chess rules hand-crafted by experts — a triumph of the old, rules-based approach",
              },
              { id: "b", label: "By learning its own strategy from millions of self-played games" },
              { id: "c", label: "By using a Transformer-based language model" },
              { id: "d", label: "By winning at Go, not chess" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "multi",
            promptMd:
              "Around 2010, **deep learning** finally took off because two long-missing ingredients became abundant. Which two? Select all that apply.",
            choices: [
              { id: "a", label: "Enormous amounts of data, thanks to the internet" },
              { id: "b", label: "Powerful computing, especially GPUs originally built for graphics" },
              { id: "c", label: "A return to hand-written expert rulebooks" },
              { id: "d", label: "Stricter regulation of AI research" },
            ],
            correctChoiceIds: ["a", "b"],
          },
          {
            kind: "mcq",
            promptMd:
              "**2012** is the field's clear \"before and after\" moment because:",
            choices: [
              {
                id: "a",
                label:
                  "A deep-learning system (AlexNet) crushed the competition at recognising the contents of photographs",
              },
              { id: "b", label: "ChatGPT was released to the public" },
              { id: "c", label: "The term \"artificial intelligence\" was coined" },
              { id: "d", label: "The first expert systems went on sale" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "Why is **AlphaGo's** 2016 win at Go considered the *new way's* triumph, in contrast to Deep Blue?",
            choices: [
              {
                id: "a",
                label:
                  "Go is too vast for brute force, so AlphaGo won by learning its own strategy — even inventing moves no human taught it",
              },
              { id: "b", label: "AlphaGo simply calculated every possible game faster" },
              { id: "c", label: "AlphaGo followed a complete rulebook written by Go masters" },
              { id: "d", label: "AlphaGo and Deep Blue used identical methods" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "mcq",
            promptMd:
              "The 2017 invention underpinning almost all of today's headline AI — including large language models — is the:",
            choices: [
              { id: "a", label: "Transformer" },
              { id: "b", label: "Expert system" },
              { id: "c", label: "Turing machine" },
              { id: "d", label: "Availability zone" },
            ],
            correctChoiceId: "a",
          },
          {
            kind: "multi",
            promptMd:
              "Which statements about **large language models (LLMs)** and **generative AI** are accurate? Select all that apply.",
            choices: [
              {
                id: "a",
                label:
                  "An LLM is trained largely by learning to predict the next word across vast amounts of text",
              },
              {
                id: "b",
                label:
                  "Generative AI produces new original work — text, images, code, audio — rather than only sorting things into categories",
              },
              {
                id: "c",
                label:
                  "ChatGPT (2022) became one of the fastest-adopted products in history by wrapping an LLM in a simple chat window",
              },
              {
                id: "d",
                label:
                  "LLMs work by following an explicit rulebook of grammar written by linguists",
              },
            ],
            correctChoiceIds: ["a", "b", "c"],
          },
        ],
      },
    },
  ],
};

export default course;
