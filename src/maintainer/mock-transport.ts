import type {
  CloseResult,
  LabelResult,
  MaintainerGitHubTransport,
  PostCommentResult,
  PrReviewResult,
  RemoteState,
} from "./github-transport.js";

export interface MockCall {
  method: string;
  args: unknown[];
  calledAt: string;
}

export class MockMaintainerTransport implements MaintainerGitHubTransport {
  readonly isDryRun: boolean;

  /** Records all calls for test assertions */
  readonly calls: MockCall[] = [];

  private commentCounter = 0;
  private reviewCounter = 0;
  private defaultState: RemoteState = {
    number: 1,
    state: "open",
    updatedAt: "2026-10-27T00:00:00.000Z",
  };
  private itemStates = new Map<number, RemoteState>();

  constructor(opts?: { isDryRun?: boolean; mockState?: Partial<RemoteState> }) {
    this.isDryRun = opts?.isDryRun ?? true;
    if (opts?.mockState) {
      this.defaultState = {
        ...this.defaultState,
        ...opts.mockState,
      };
    }
  }

  private recordCall(method: string, args: unknown[]) {
    this.calls.push({
      method,
      args,
      calledAt: new Date().toISOString(),
    });
  }

  /**
   * Configure mock state returned by getCurrentState.
   * If `number` is provided, sets state for that specific item; otherwise updates default state.
   */
  setMockState(state: Partial<RemoteState> & { number?: number }): void {
    if (state.number !== undefined) {
      const current = this.itemStates.get(state.number) ?? { ...this.defaultState, number: state.number };
      this.itemStates.set(state.number, { ...current, ...state });
    } else {
      this.defaultState = { ...this.defaultState, ...state };
    }
  }

  /** Clear recorded calls */
  resetCalls(): void {
    this.calls.length = 0;
  }

  async postComment(repo: string, number: number, body: string): Promise<PostCommentResult> {
    this.recordCall("postComment", [repo, number, body]);
    this.commentCounter++;
    return {
      success: true,
      commentId: `mock-comment-${this.commentCounter}`,
      url: `https://github.com/${repo}/issues/${number}#issuecomment-${this.commentCounter}`,
      dryRun: this.isDryRun,
    };
  }

  async submitPrReview(
    repo: string,
    number: number,
    opts: {
      event: "COMMENT" | "REQUEST_CHANGES";
      body: string;
    },
  ): Promise<PrReviewResult> {
    if ((opts.event as string) === "APPROVE") {
      throw new Error("Approval reviews are strictly prohibited in maintainer workflow");
    }
    this.recordCall("submitPrReview", [repo, number, opts]);
    this.reviewCounter++;
    return {
      success: true,
      reviewId: `mock-review-${this.reviewCounter}`,
      url: `https://github.com/${repo}/pull/${number}#pullrequestreview-${this.reviewCounter}`,
      event: opts.event,
      dryRun: this.isDryRun,
    };
  }

  async closeItem(repo: string, number: number, type: "pr" | "issue"): Promise<CloseResult> {
    this.recordCall("closeItem", [repo, number, type]);
    const current = this.itemStates.get(number) ?? { ...this.defaultState, number };
    this.itemStates.set(number, {
      ...current,
      state: "closed",
      updatedAt: new Date().toISOString(),
    });
    return {
      success: true,
      dryRun: this.isDryRun,
    };
  }

  async applyLabel(repo: string, number: number, label: string): Promise<LabelResult> {
    this.recordCall("applyLabel", [repo, number, label]);
    return {
      success: true,
      label,
      dryRun: this.isDryRun,
    };
  }

  async getCurrentState(repo: string, number: number, type: "pr" | "issue"): Promise<RemoteState> {
    this.recordCall("getCurrentState", [repo, number, type]);
    const specific = this.itemStates.get(number);
    if (specific) {
      return { ...specific };
    }
    return {
      ...this.defaultState,
      number,
    };
  }
}
