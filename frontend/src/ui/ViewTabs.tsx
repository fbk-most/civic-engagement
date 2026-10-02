export type AppView = "2d" | "3d" | "indicators";

const TABS: { value: AppView; label: string }[] = [
  { value: "2d", label: "Mappa 2D" },
  { value: "3d", label: "Vista 3D" },
  { value: "indicators", label: "Indicatori" },
];

interface Props {
  view: AppView;
  onChange: (view: AppView) => void;
}

export function ViewTabs({ view, onChange }: Props) {
  return (
    <nav className="view-tabs" role="tablist">
      {TABS.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === view}
          className={tab.value === view ? "view-tabs__tab view-tabs__tab--active" : "view-tabs__tab"}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
