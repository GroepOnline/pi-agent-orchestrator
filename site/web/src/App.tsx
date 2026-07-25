import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { SiteLayout } from "@/components/layout/site-layout";
import { CapabilitiesPage } from "@/pages/capabilities-page";
import { DocViewPage } from "@/pages/doc-view-page";
import { DocsPage } from "@/pages/docs-page";
import { InstallPage } from "@/pages/install-page";
import { LandingPage } from "@/pages/landing-page";
import { ShowcasePage } from "@/pages/showcase-page";

export function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
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
    </BrowserRouter>
  );
}
