import { z } from "zod";
import { COMMAND_MODES } from "./types";

/** How the agent may work and which model, as a session's message or mode change can set them. */
export const sessionOptions = z
  .object({
    modelId: z.string().max(120).nullable().optional(),
    approvePlans: z.boolean().optional(),
    reviewEdits: z.boolean().optional(),
    commands: z.enum(COMMAND_MODES).optional(),
    readOnly: z.boolean().optional(),
  })
  .strict();
