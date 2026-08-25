import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrationCandidateCardSummary, IntegrationCandidateDetails } from "./IntegrationCandidate";

describe("Integration Agent projection", () => {
  it("does not fetch or display Candidate/revision details", () => {
    render(<IntegrationCandidateCardSummary taskId="task-v3" />);
    expect(screen.getByText("Integration Agent")).toBeTruthy();
    expect(screen.queryByText(/Candidate|revision/i)).toBeNull();
  });

  it("keeps the historical component export as a static Agent summary", () => {
    render(<IntegrationCandidateDetails taskId="task-v3" />);
    expect(screen.getByLabelText("Integration Agent 状态")).toBeTruthy();
  });
});
