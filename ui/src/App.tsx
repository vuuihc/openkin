import { NavLink, Route, Routes } from "react-router-dom";
import ApprovalsPage from "./pages/ApprovalsPage";
import SettingsPage from "./pages/SettingsPage";
import TaskDetailPage from "./pages/TaskDetailPage";
import TasksPage from "./pages/TasksPage";

const navClass = ({ isActive }: { isActive: boolean }) =>
  [
    "px-3 py-2 rounded-lg text-sm font-medium transition-colors",
    isActive
      ? "bg-surface-raised text-accent"
      : "text-zinc-400 hover:text-zinc-100 hover:bg-surface-raised/60",
  ].join(" ");

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-surface-border bg-surface/90 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-3xl px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold tracking-tight text-zinc-50">Kin</span>
            <span className="hidden sm:inline text-xs text-zinc-500">agent console</span>
          </div>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={navClass}>
              Tasks
            </NavLink>
            <NavLink to="/approvals" className={navClass}>
              Approvals
            </NavLink>
            <NavLink to="/settings" className={navClass}>
              Settings
            </NavLink>
          </nav>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-3xl px-4 py-6">
        <Routes>
          <Route path="/" element={<TasksPage />} />
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
