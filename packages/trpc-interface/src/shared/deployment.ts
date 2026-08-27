import { z } from "zod";
import { router, procedure } from "./trpc";

// Has corresponding type in saas
export const publishInput = z.object({
  // used to load build data from the builder with build.loadProjectBundleByBuildId
  buildId: z.string(),
  builderOrigin: z.string(),
  githubSha: z.string().optional(),

  destination: z.enum(["saas", "static"]),
  // preview support
  branchName: z.string(),
  // action log helper (not used for deployment, but for action logs readablity)
  logProjectName: z.string(),

  // Fork: our custom AWS deployment server needs these to know what/where to
  // publish and which access links (tokens) to expose.
  projectId: z.string().optional(),
  domains: z.array(z.string()).optional(),
  links: z
    .array(
      z.object({
        token: z.string(),
        name: z.string(),
        relation: z.string(),
        canCopy: z.boolean(),
        canClone: z.boolean(),
        canPublish: z.boolean(),
        canUseApi: z.boolean(),
        projectId: z.string(),
        createdAt: z.string(),
      })
    )
    .optional(),
});

export const unpublishInput = z.object({
  domain: z.string(),
});

export const output = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

/**
 * This is the ContentManagementService. It is currently used to publish content to a custom domain.
 * In the future, additional methods, such as a 'preview' function, could be added.
 **/
export const deploymentRouter = router({
  publish: procedure
    .input(publishInput)
    .output(output)
    .mutation(() => {
      return {
        success: true,
      };
    }),
  unpublish: procedure
    .input(unpublishInput)
    .output(output)
    .mutation(() => {
      return {
        success: true,
      };
    }),
});
