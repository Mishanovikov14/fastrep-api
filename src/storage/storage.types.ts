export type PresignedUploadContract = {
  method: 'POST';
  url: string;
  fields: Record<string, string>;
  expiresAt: Date;
};

export type StoredObjectMetadata = {
  size: number;
};

export type PresignedDownloadContract = {
  url: string;
  expiresAt: Date;
};
