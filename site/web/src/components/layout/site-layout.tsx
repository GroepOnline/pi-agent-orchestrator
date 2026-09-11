import { Outlet } from "react-router";

import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { RouteMetadata } from "@/components/route-metadata";

export function SiteLayout() {
  return (
    <div className="flex min-h-svh flex-col">
      <RouteMetadata />
      <SiteHeader />
      <main className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}
