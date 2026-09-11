import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { SiteLayout } from "@/components/layout/site-layout";
import { LandingPage } from "@/pages/landing-page";

const CapabilitiesPage = lazy(() => import("@/pages/capabilities-page").then((m) => ({ default: m.CapabilitiesPage })));
const DocViewPage = lazy(() => import("@/pages/doc-view-page").then((m) => ({ default: m.DocViewPage })));
const DocsPage = lazy(() => import("@/pages/docs-page").then((m) => ({ default: m.DocsPage })));
const InstallPage = lazy(() => import("@/pages/install-page").then((m) => ({ default: m.InstallPage })));
const ShowcasePage = lazy(() => import("@/pages/showcase-page").then((m) => ({ default: m.ShowcasePage })));

function RouteFallback() {
  return <div className="mx-auto w-full max-w-6xl px-5 py-16 text-sm text-muted-foreground">Loading…</div>;
}

export function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route element={<SiteLayout />}>
            <Route index element={<LandingPage />} />
            <Route path="install" element={<InstallPage />} />
            <Route path="docs" element={<DocsPage />} />
            <Route path="docs/:docId" element={<DocViewPage />} />
            <Route path="capabilities" element={<CapabilitiesPage />} />
            <Route path="showcase" element={<ShowcasePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
