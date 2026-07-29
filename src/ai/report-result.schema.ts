import { z } from 'zod';

const paragraphBlockSchema = z
  .object({
    type: z.literal('paragraph'),
    text: z.string().trim().min(1).max(8_000),
  })
  .strict();

const bulletListBlockSchema = z
  .object({
    type: z.literal('bulletList'),
    items: z.array(z.string().trim().min(1).max(1_000)).min(1).max(30),
  })
  .strict();

export const reportResultSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    subtitle: z.string().trim().min(1).max(500).nullable(),
    summary: z.string().trim().min(1).max(8_000),
    sections: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(300),
            blocks: z
              .array(
                z.discriminatedUnion('type', [
                  paragraphBlockSchema,
                  bulletListBlockSchema,
                ]),
              )
              .min(1)
              .max(50),
            imageAssetIds: z.array(z.string().uuid()).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    conclusion: z.string().trim().min(1).max(8_000).nullable(),
    recommendations: z.array(z.string().trim().min(1).max(2_000)).max(30),
  })
  .strict();

export type ReportResult = z.infer<typeof reportResultSchema>;
