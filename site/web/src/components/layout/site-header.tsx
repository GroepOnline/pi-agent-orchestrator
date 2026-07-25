import { Link, NavLink } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PRODUCT_NAME } from "@/lib/site";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/", label: "Home", end: true },
  { to: "/showcase", label: "Showcase", end: false },
  { to: "/capabilities", label: "Capabilities", end: false },
  { to: "/install", label: "Install", end: false },
  { to: "/docs", label: "Docs", end: false },
];

export function SiteHeader() {
  return (
    <header className="border-b border-border/80">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <Link to="/" className="flex items-center gap-3 no-underline">
          <span className="text-base font-semibold tracking-tight text-foreground">{PRODUCT_NAME}</span>
          <Badge variant="secondary" className="hidden sm:inline-flex">
            Pi extension
          </Badge>
        </Link>
        <nav aria-label="Primary navigation" className="flex flex-wrap items-center gap-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                  isActive && "bg-secondary text-foreground",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Separator />
    </header>
  );
}
