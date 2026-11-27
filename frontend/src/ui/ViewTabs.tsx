import { tr } from "../i18n/lang";

export type AppView = "2d" | "3d" | "indicators";

const TABS: { value: AppView; label: [it: string, en: string] }[] = [
  { value: "2d", label: ["Mappa 2D", "2D map"] },
  { value: "3d", label: ["Vista 3D", "3D view"] },
  { value: "indicators", label: ["Indicatori", "Indicators"] },
];

interface Props {
  view: AppView;
  /** The tabs offered (see views.ts): all by default. */
  tabs?: AppView[];
  onChange: (view: AppView) => void;
}

export function ViewTabs({ view, tabs, onChange }: Props) {
  return (
    <nav className="view-tabs" role="tablist">
      {TABS.filter((tab) => !tabs || tabs.includes(tab.value)).map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === view}
          className={tab.value === view ? "view-tabs__tab view-tabs__tab--active" : "view-tabs__tab"}
          onClick={() => onChange(tab.value)}
        >
          {tr(...tab.label)}
        </button>
      ))}
    </nav>
  );
}
