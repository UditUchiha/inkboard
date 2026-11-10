import { Sparkles } from "lucide-react";
import { useState } from "react";
import { clsx } from "clsx";
import { AI_PROMPTS, CLASSROOM_SCENE, EQUATION_SCENE, SUGGEST_SCENE } from "../lib/showcaseScenes";
import { ShowcaseScene } from "./ShowcaseScene";

function AiDemo() {
  const [chosen, setChosen] = useState(0);
  const { prompt, scene } = AI_PROMPTS[chosen];

  return (
    <div>
      <ShowcaseScene key={chosen} scene={scene} label={`A board the AI drew for: ${prompt}`} />
      <div className="mt-3 flex items-center gap-2 rounded-xl border border-rule bg-surface px-3 py-2 text-sm">
        <Sparkles className="size-4 shrink-0 text-signal" aria-hidden="true" />
        <span className="truncate">{prompt}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Try another prompt">
        {AI_PROMPTS.map((option, index) => (
          <button
            key={option.prompt}
            type="button"
            onClick={() => setChosen(index)}
            aria-pressed={index === chosen}
            className={clsx(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              index === chosen
                ? "border-ink bg-ink text-on-ink"
                : "border-rule text-graphite hover:border-ink hover:text-ink",
            )}
          >
            {option.prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

const SHOWS = [
  {
    eyebrow: "AI drawing",
    title: "Describe it. Watch it get drawn.",
    body: "Type what you want and the diagram appears on the board, shape by shape. Bring your own key from Anthropic, OpenAI, Gemini, OpenRouter or Groq. It never leaves your browser.",
    demo: <AiDemo />,
  },
  {
    eyebrow: "Suggest mode",
    title: "Let people propose, not overwrite.",
    body: "Share a link that lets anyone suggest changes. They show up marked in that person's colour, and nothing moves until you accept.",
    demo: <ShowcaseScene scene={SUGGEST_SCENE} label="Maya suggests a step in a flow and the owner accepts it" />,
  },
  {
    eyebrow: "Classroom mode",
    title: "One board, a frame for every student.",
    body: "Students claim a frame and draw only there. The teacher sees every frame live and can copy one to the whole class.",
    demo: <ShowcaseScene scene={CLASSROOM_SCENE} label="Three students drawing in their own frames at once" />,
  },
  {
    eyebrow: "Equations",
    title: "Handwriting in, LaTeX out.",
    body: "Scribble a formula with the pen, select it, and it becomes a typeset equation you can keep editing.",
    demo: (
      <ShowcaseScene scene={EQUATION_SCENE} label="Handwritten E equals m c squared turning into a typeset formula" />
    ),
  },
];

export function Showcase() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-20 px-4 py-20 sm:px-6">
      {SHOWS.map((show, index) => (
        <section
          key={show.eyebrow}
          aria-labelledby={`show-${index}`}
          className="grid items-center gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-14"
        >
          <div className={clsx("max-w-md", index % 2 === 1 && "lg:order-last")}>
            <p className="text-sm font-semibold tracking-wide text-signal uppercase">{show.eyebrow}</p>
            <h2 id={`show-${index}`} className="mt-2 text-3xl font-extrabold tracking-tight [font-stretch:80%]">
              {show.title}
            </h2>
            <p className="mt-3 leading-relaxed text-graphite">{show.body}</p>
          </div>
          {show.demo}
        </section>
      ))}
    </div>
  );
}
