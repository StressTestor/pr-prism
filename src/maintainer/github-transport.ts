import { Octokit } from "@octokit/rest";
import { createWriteGate, type WriteGate } from "../write-gate.js";

export interface MaintainerGitHubTransport {
  readonly isDryRun: boolean;

  /** Post a regular issue/PR comment */
  postComment(repo: string, number: number, body: string): Promise<PostCommentResult>;

  /** Submit a formal PR review (COMMENT or REQUEST_CHANGES only — never APPROVE) */
  submitPrReview(
    repo: string,
    number: number,
    opts: {
      event: "COMMENT" | "REQUEST_CHANGES";
      body: string;
    },
  ): Promise<PrReviewResult>;

  /** Close a PR or issue */
  closeItem(repo: string, number: number, type: "pr" | "issue"): Promise<CloseResult>;

  /** Apply a label */
  applyLabel(repo: string, number: number, label: string): Promise<LabelResult>;

  /** Read current state (for staleness check) */
  getCurrentState(repo: string, number: number, type: "pr" | "issue"): Promise<RemoteState>;
}

export interface RemoteState {
  updatedAt: string;
  state: "open" | "closed" | "merged";
  number: number;
}

export interface PostCommentResult {
  success: boolean;
  commentId?: string;
  url?: string;
  dryRun: boolean;
}

export interface PrReviewResult {
  success: boolean;
  reviewId?: string;
  url?: string;
  event: "COMMENT" | "REQUEST_CHANGES";
  dryRun: boolean;
}

export interface CloseResult {
  success: boolean;
  dryRun: boolean;
}

export interface LabelResult {
  success: boolean;
  label: string;
  dryRun: boolean;
}

export class OctokitMaintainerTransport implements MaintainerGitHubTransport {
  private octokit: Octokit;
  private gate: WriteGate;
  private defaultOwner?: string;

  constructor(opts?: {
    octokit?: Octokit;
    token?: string;
    gate?: WriteGate;
    defaultOwner?: string;
  }) {
    this.octokit =
      opts?.octokit ??
      new Octokit({
        auth: opts?.token ?? process.env.GITHUB_TOKEN,
      });
    this.gate = opts?.gate ?? createWriteGate("dry-run");
    this.defaultOwner = opts?.defaultOwner;
  }

  get isDryRun(): boolean {
    return this.gate.mode === "dry-run";
  }

  private parseRepo(repo: string): { owner: string; repo: string } {
    if (repo.includes("/")) {
      const [owner, name] = repo.split("/");
      return { owner, repo: name };
    }
    if (this.defaultOwner) {
      return { owner: this.defaultOwner, repo };
    }
    throw new Error(`Repository must be in "owner/repo" format or defaultOwner configured: received "${repo}"`);
  }

  async postComment(repo: string, number: number, body: string): Promise<PostCommentResult> {
    const { owner, repo: name } = this.parseRepo(repo);
    const guarded = await this.gate.guard({
      kind: "comment",
      target: `#${number}`,
      run: async () => {
        const res = await this.octokit.issues.createComment({
          owner,
          repo: name,
          issue_number: number,
          body,
        });
        return res.data;
      },
    });

    if (!guarded.applied || !guarded.result) {
      return { success: true, dryRun: true };
    }
    return {
      success: true,
      commentId: String(guarded.result.id),
      url: guarded.result.html_url,
      dryRun: false,
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
    const { owner, repo: name } = this.parseRepo(repo);
    const guarded = await this.gate.guard({
      kind: "comment",
      target: `#${number} review:${opts.event}`,
      run: async () => {
        const res = await this.octokit.pulls.createReview({
          owner,
          repo: name,
          pull_number: number,
          event: opts.event,
          body: opts.body,
        });
        return res.data;
      },
    });

    if (!guarded.applied || !guarded.result) {
      return { success: true, event: opts.event, dryRun: true };
    }
    return {
      success: true,
      reviewId: String(guarded.result.id),
      url: guarded.result.html_url,
      event: opts.event,
      dryRun: false,
    };
  }

  async closeItem(repo: string, number: number, type: "pr" | "issue"): Promise<CloseResult> {
    const { owner, repo: name } = this.parseRepo(repo);
    const guarded = await this.gate.guard({
      kind: "close",
      target: `#${number}`,
      run: async () => {
        if (type === "pr") {
          await this.octokit.pulls.update({
            owner,
            repo: name,
            pull_number: number,
            state: "closed",
          });
        } else {
          await this.octokit.issues.update({
            owner,
            repo: name,
            issue_number: number,
            state: "closed",
          });
        }
      },
    });

    return {
      success: true,
      dryRun: !guarded.applied,
    };
  }

  async applyLabel(repo: string, number: number, label: string): Promise<LabelResult> {
    const { owner, repo: name } = this.parseRepo(repo);
    const guarded = await this.gate.guard({
      kind: "label",
      target: `#${number} +${label}`,
      run: async () => {
        await this.octokit.issues.addLabels({
          owner,
          repo: name,
          issue_number: number,
          labels: [label],
        });
      },
    });

    return {
      success: true,
      label,
      dryRun: !guarded.applied,
    };
  }

  async getCurrentState(repo: string, number: number, type: "pr" | "issue"): Promise<RemoteState> {
    const { owner, repo: name } = this.parseRepo(repo);
    if (type === "pr") {
      const res = await this.octokit.pulls.get({
        owner,
        repo: name,
        pull_number: number,
      });
      const state: "open" | "closed" | "merged" = res.data.merged
        ? "merged"
        : res.data.state === "closed"
          ? "closed"
          : "open";
      return {
        number: res.data.number,
        state,
        updatedAt: res.data.updated_at,
      };
    } else {
      const res = await this.octokit.issues.get({
        owner,
        repo: name,
        issue_number: number,
      });
      const state: "open" | "closed" = res.data.state === "closed" ? "closed" : "open";
      return {
        number: res.data.number,
        state,
        updatedAt: res.data.updated_at,
      };
    }
  }
}
