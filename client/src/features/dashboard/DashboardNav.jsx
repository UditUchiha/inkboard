import clsx from "clsx";
import { Plus } from "lucide-react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { SECTIONS } from "./sections";

export const sectionPath = (id) => (id === "all" ? "/boards" : `/boards?show=${id}`);

function NavLink({ section, active, count }) {
  const Icon = section.icon;
  return (
    <li className="max-md:shrink-0">
      <Link
        to={sectionPath(section.id)}
        aria-current={active ? "page" : undefined}
        className={clsx(
          "flex h-10 items-center gap-3 rounded-lg px-3 text-[15px] font-medium whitespace-nowrap transition-colors",
          active ? "bg-marker text-[#16213a]" : "text-ink hover:bg-ink/6",
        )}
      >
        <Icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="flex-1">{section.label}</span>
        {count > 0 && (
          <span className={clsx("text-sm tabular-nums", active ? "text-[#16213a]/70" : "text-graphite")}>{count}</span>
        )}
      </Link>
    </li>
  );
}

/** Where to look: a sidebar on wide screens, a scrolling row of pills on phones. */
export function DashboardNav({ activeId, counts, onCreate, creating }) {
  const groups = [
    SECTIONS.filter((section) => section.group === "boards"),
    SECTIONS.filter((section) => section.group === "tidy"),
  ];

  return (
    <aside className="md:sticky md:top-24 md:self-start">
      <Button icon={Plus} onClick={onCreate} loading={creating} className="w-full max-md:hidden">
        New board
      </Button>
      <nav aria-label="Boards" className="md:mt-5">
        <div className="flex gap-1 overflow-x-auto max-md:pb-1 md:flex-col md:overflow-visible">
          {groups.map((sections, index) => (
            <ul
              key={sections[0].id}
              className={clsx("flex gap-1 md:flex-col", index > 0 && "md:mt-3 md:border-t md:border-rule md:pt-3")}
            >
              {sections.map((section) => (
                <NavLink
                  key={section.id}
                  section={section}
                  active={section.id === activeId}
                  count={counts[section.id]}
                />
              ))}
            </ul>
          ))}
        </div>
      </nav>
    </aside>
  );
}
