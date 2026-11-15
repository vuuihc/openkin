import { useId, useRef, useState, type ReactNode } from "react";
import { Route } from "react-router-dom";
import ActionSheet, { type ActionSheetRow } from "../components/ui/ActionSheet";
import Button from "../components/ui/Button";
import PendingBadge from "../components/ui/PendingBadge";
import Popover from "../components/ui/Popover";
import SearchSelect from "../components/ui/SearchSelect";
import SessionFilters, {
  type SessionScopeFilter,
  type SessionStatusFilter,
} from "../components/ui/SessionFilters";
import SheetSelect from "../components/ui/SheetSelect";

/**
 * F4: the developer-only gallery for the facade's adopted controls.
 *
 * A facade slice should not have to invent its own idea of hover, focus,
 * disabled, loading, error or IME — nor of the phone and desktop shapes. This
 * page is where those are compared side by side. It is deliberately not a
 * shipped surface: `designSystemRoute` registers nothing when Vite's
 * `import.meta.env.DEV` is false, so `/dev/components` falls through to the
 * console's `*` redirect in a production build.
 *
 * Scaffolding labels stay English. The page is not reachable in the shipped
 * console, and the two locale files are shared by every UI slice; the real
 * controls still translate their own strings through `useT` inside each
 * primitive.
 *
 * One column at every width (390 and 1100 alike). The phone and desktop blocks
 * are explicit, not a responsive reflow, because the point is to show each
 * control in the form it takes at its own breakpoint.
 */

const ROLES = [
  { id: "none", label: "No role" },
  { id: "reviewer", label: "Reviewer" },
  { id: "writer", label: "Writer" },
  { id: "removed", label: "Remove role", destructive: true },
];

const DENSITIES = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
];

const MODELS = [
  { id: "sonnet", label: "Claude Sonnet 5.5", detail: "balanced", group: "Anthropic" },
  { id: "opus", label: "Claude Opus 5.5", detail: "deep", group: "Anthropic" },
  { id: "nano", label: "Nano", detail: "fast", group: "Local" },
];

const SEARCH_MODELS = [
  { id: "none", label: "None" },
  { id: "nano", label: "Nano" },
];

const SECTIONS = [
  { id: "action-sheet", label: "ActionSheet" },
  { id: "pending-badge", label: "PendingBadge" },
  { id: "search-select", label: "SearchSelect" },
  { id: "session-filters", label: "SessionFilters" },
  { id: "sheet-select", label: "SheetSelect" },
  { id: "button", label: "Button" },
  { id: "popover", label: "Popover" },
  { id: "states", label: "States" },
] as const;

/**
 * The dev-only route.
 *
 * The flag is a prop so a test can prove the production shape without stubbing
 * the environment; it defaults to Vite's compile-time constant. It returns a
 * `<Route>` or `null` rather than being a component wrapper because React
 * Router v6 rejects a non-`<Route>` child of `<Routes>` — including a
 * component that only renders one. A returned `null` is ignored. `App` renders
 * `{designSystemRoute()}` inside its existing `<Routes>`.
 */
export function designSystemRoute(dev: boolean = import.meta.env.DEV) {
  return dev ? <Route path="/dev/components" element={<DesignSystemPage />} /> : null;
}

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      data-primitive={title}
      className="scroll-mt-24 border-t border-[var(--kin-hairline)] py-6 first:border-t-0 first:pt-0"
    >
      <h2 id={`${id}-heading`} className="text-title text-kin-text">
        {title}
      </h2>
      <p className="mt-1 max-w-page-narrow text-body leading-prose text-kin-secondary">{note}</p>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/**
 * One width's form of a control. A left rule, not a card: the section is
 * already the grouping, and cards inside cards is the shape TASTE rejects.
 */
function FormBlock({
  form,
  control,
  title,
  note,
  children,
}: {
  form: "phone" | "desktop" | "both";
  control: string;
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <div
      data-form={form}
      data-gallery-control={control}
      className="border-l border-[var(--kin-hairline)] pl-4"
    >
      <h3 className="text-strong font-semibold text-kin-text">{title}</h3>
      <p className="mt-1 text-body leading-prose text-kin-secondary">{note}</p>
      <div className="mt-3 flex flex-col items-start gap-3">{children}</div>
    </div>
  );
}

export default function DesignSystemPage() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [lastAction, setLastAction] = useState("none");
  const [role, setRole] = useState("reviewer");
  const [density, setDensity] = useState("comfortable");
  const [model, setModel] = useState("sonnet");
  const [errorValue, setErrorValue] = useState("opus");
  const [imeModel, setImeModel] = useState("none");
  const [status, setStatus] = useState<SessionStatusFilter>("");
  const [scope, setScope] = useState<SessionScopeFilter>("active");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverTrigger = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  const actionRows: ActionSheetRow[] = [
    {
      id: "rename",
      label: "Rename",
      onSelect: () => setLastAction("Rename"),
    },
    {
      id: "reviewer",
      label: "Set role: reviewer",
      selected: role === "reviewer",
      onSelect: () => setLastAction("Reviewer"),
    },
    {
      id: "archive",
      label: "Archive",
      destructive: true,
      onSelect: () => setLastAction("Archive"),
    },
    {
      id: "unavailable",
      label: "Unavailable row",
      disabled: true,
      onSelect: () => setLastAction("Unavailable"),
    },
  ];

  return (
    <main className="mx-auto w-full max-w-page px-4 py-6 sm:px-6 sm:py-8">
      <header>
        <h1 className="text-hero text-kin-text">Design system gallery</h1>
        <p className="mt-1 max-w-page-narrow text-body leading-prose text-kin-secondary">
          Developer-only. This route exists only while <code>import.meta.env.DEV</code> is true; a
          production build registers no route and falls through to the console&apos;s{" "}
          <code>*</code> redirect. Scaffolding labels are English because this page is not
          reachable in the shipped console.
        </p>
      </header>

      <nav
        aria-label="Sections"
        className="kin-glass sticky top-0 z-10 -mx-4 mt-4 flex gap-3 overflow-x-auto border-y border-[var(--kin-hairline)] px-4 py-2 text-caption sm:-mx-6 sm:px-6"
      >
        {SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="flex-none text-kin-blue-ink hover:underline"
          >
            {section.label}
          </a>
        ))}
      </nav>

      <Section
        id="action-sheet"
        title="ActionSheet"
        note="The phone's action list: a title, full-width rows, and one Cancel. The current value is marked for sight and for assistive tech; a destructive row takes the console's red ink. Desktop uses an anchored menu instead (TASTE 3)."
      >
        <FormBlock
          form="phone"
          control="action-sheet-phone"
          title="Phone"
          note="One live sheet. Open it, pick a row, and the sheet closes before the row runs."
        >
          <Button variant="secondary" onClick={() => setSheetOpen(true)}>
            Open action sheet
          </Button>
          <p className="text-caption text-kin-muted">Last action: {lastAction}</p>
          <ActionSheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            title="Session actions"
            subtitle="Runs on this machine"
            rows={actionRows}
          />
        </FormBlock>
      </Section>

      <Section
        id="pending-badge"
        title="PendingBadge"
        note="The row-end marker for work waiting on the reader. It is a mark, not a control: the conversation row stays the only click target."
      >
        <FormBlock
          form="both"
          control="pending-badge"
          title="Both widths"
          note="A count above nine draws “9+” while the accessible name carries the real number."
        >
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-body text-kin-secondary">Nothing waiting:</span>
            <PendingBadge count={0} />
            <span className="text-caption text-kin-muted">(renders nothing)</span>
            <PendingBadge count={3} />
            <PendingBadge count={12} />
          </div>
        </FormBlock>
      </Section>

      <Section
        id="search-select"
        title="SearchSelect"
        note="A choice control whose list can be longer than a menu: a filter field, grouped rows, and a scrollable list. The chip and the full-width field are the same control with two faces."
      >
        <FormBlock
          form="desktop"
          control="search-select-desktop"
          title="Desktop"
          note="A field-shaped trigger opens an anchored listbox. The same component renders a second trigger below 640px that opens the phone sheet."
        >
          <SearchSelect
            label="Model"
            variant="field"
            searchable
            value={model}
            options={MODELS}
            onChange={setModel}
            searchPlaceholder="Search models"
            emptyLabel="No matching models"
            className="max-w-xs"
          />
        </FormBlock>
      </Section>

      <Section
        id="session-filters"
        title="SessionFilters"
        note="The conversation list's status and project scope. It opens a panel under its trigger rather than a sheet, so both widths use the same control (TASTE 14: the container does not grow)."
      >
        <FormBlock
          form="desktop"
          control="session-filters"
          title="Desktop"
          note="Open the panel to see grouped chips: status, scope, and project order."
        >
          <SessionFilters
            status={status}
            scope={scope}
            sortMode="active"
            onSortChange={() => undefined}
            onChange={(next) => {
              setStatus(next.status);
              setScope(next.scope);
            }}
          />
        </FormBlock>
      </Section>

      <Section
        id="sheet-select"
        title="SheetSelect"
        note="A compact choice control with one shape per width. The chip is identical; only what it opens changes."
      >
        <FormBlock
          form="phone"
          control="sheet-select-phone"
          title="Phone"
          note="Below 768px the chip opens the console's action sheet, with the safe area and the touch floor built in."
        >
          <SheetSelect label="Role" value={role} options={ROLES} onChange={setRole} />
        </FormBlock>
        <FormBlock
          form="desktop"
          control="sheet-select-desktop"
          title="Desktop"
          note="Above 768px the same chip opens a menu anchored to itself. This second instance is here so both shapes are visible on one page."
        >
          <SheetSelect
            label="Density"
            value={density}
            options={DENSITIES}
            onChange={setDensity}
          />
        </FormBlock>
      </Section>

      <Section
        id="button"
        title="Button"
        note="The console's three action weights on the existing kin-btn-* vocabulary. The 44px touch floor and the focus outline travel with the class."
      >
        <FormBlock
          form="both"
          control="button-variants"
          title="Both widths"
          note="Primary is the one filled action on a surface; secondary is a bordered peer; quiet takes a fill only on hover."
        >
          <div className="flex flex-wrap gap-2">
            <Button>Primary action</Button>
            <Button variant="secondary">Secondary action</Button>
            <Button variant="quiet">Quiet action</Button>
          </div>
        </FormBlock>
      </Section>

      <Section
        id="popover"
        title="Popover"
        note="A controlled, viewport-anchored panel portaled to <body>. Escape, an outside pointer, or Tab out closes it and returns focus to the trigger."
      >
        <FormBlock
          form="desktop"
          control="popover-demo"
          title="Desktop"
          note="The trigger owns the open state; the primitive owns the layer."
        >
          <Button
            ref={popoverTrigger}
            variant="secondary"
            aria-expanded={popoverOpen}
            aria-controls={popoverOpen ? popoverId : undefined}
            onClick={() => setPopoverOpen((open) => !open)}
          >
            Open popover
          </Button>
          <Popover
            open={popoverOpen}
            onOpenChange={setPopoverOpen}
            triggerRef={popoverTrigger}
            label="Popover example"
            id={popoverId}
            width={240}
          >
            <p className="px-2 py-1.5 text-body leading-prose text-kin-secondary">
              An anchored panel. Escape or an outside click dismisses it.
            </p>
          </Popover>
        </FormBlock>
      </Section>

      <Section
        id="states"
        title="States"
        note="One control per state the rules name. The rules accept a documented class or data-state where a state cannot be driven in jsdom, and error text where a control has no error prop yet."
      >
        <div className="flex flex-wrap items-start gap-6">
          <div data-state="default" className="flex flex-col gap-1">
            <Button variant="secondary">Default action</Button>
            <span className="text-caption text-kin-muted">default</span>
          </div>
          <div data-state="pressed" className="flex flex-col gap-1">
            <Button variant="secondary">Pressed action</Button>
            <span className="text-caption text-kin-muted">
              pressed (data-state; the control&apos;s own classes draw the wash)
            </span>
          </div>
          <div data-state="disabled" className="flex flex-col gap-1">
            <Button variant="secondary" disabled>
              Disabled example
            </Button>
            <span className="text-caption text-kin-muted">disabled</span>
          </div>
          <div data-state="loading" className="flex flex-col gap-1">
            <Button variant="secondary" disabled aria-busy="true">
              Saving changes…
            </Button>
            <span className="text-caption text-kin-muted">loading (aria-busy + disabled)</span>
          </div>
          <div data-state="focus" className="flex flex-col gap-1">
            <Button variant="secondary">Focus me</Button>
            <span className="text-caption text-kin-muted">focus (Tab to it)</span>
          </div>
        </div>

        <div data-state="error" data-gallery-control="error-field">
          <SearchSelect
            label="Error field"
            variant="field"
            value={errorValue}
            options={MODELS}
            onChange={setErrorValue}
            className="max-w-xs"
          />
          <p className="mt-1 text-caption text-kin-red-ink">That name is already taken.</p>
        </div>

        <div data-gallery-control="ime-search">
          <SearchSelect
            label="Search"
            searchable
            value={imeModel}
            options={SEARCH_MODELS}
            onChange={setImeModel}
            searchPlaceholder="Search"
            emptyLabel="No matches"
            className="max-w-xs"
          />
          <p className="mt-1 text-caption text-kin-muted">Selected: {imeModel}</p>
        </div>
      </Section>
    </main>
  );
}
