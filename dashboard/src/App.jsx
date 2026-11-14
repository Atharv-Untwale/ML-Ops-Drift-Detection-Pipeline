import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import Drift from "./pages/Drift.jsx";
import ComingSoon from "./pages/ComingSoon.jsx";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Drift />} />
        <Route
          path="performance"
          element={<ComingSoon title="Performance" feeds={["GET /api/performance", "GET /api/labels/coverage"]} />}
        />
        <Route
          path="retraining"
          element={<ComingSoon title="Retraining" feeds={["GET /api/retrain/events"]} />}
        />
        <Route
          path="models"
          element={<ComingSoon title="Models" feeds={["GET /api/models/versions"]} />}
        />
        <Route path="*" element={<ComingSoon title="Not found" feeds={[]} />} />
      </Route>
    </Routes>
  );
}
