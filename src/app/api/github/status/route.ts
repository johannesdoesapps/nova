import { installUrl } from "@/lib/github/app";
import { githubContext } from "@/lib/github/server";
import { errorResponse } from "@/lib/http";

/** GET /api/github/status — is GitHub set up, linked to this account, and installed on it? */
export async function GET() {
  try {
    const { cfg, identity, installation } = await githubContext();
    return Response.json({
      configured: !!cfg,
      linked: !!identity,
      login: identity?.login ?? null,
      installed: !!installation,
      repositorySelection: installation?.repositorySelection ?? null,
      installUrl: cfg ? installUrl(cfg) : null,
      manageUrl: installation ? `https://github.com/settings/installations/${installation.id}` : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
