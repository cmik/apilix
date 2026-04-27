/**
 * @deprecated
 * MinIO is now handled by the unified s3Adapter (which supports S3-compatible
 * endpoints via the optional `endpoint` config field). This file re-exports
 * s3Adapter as minioAdapter so that any stored sync configs with
 * `provider: 'minio'` continue to work without migration.
 */
export { s3Adapter as minioAdapter } from './s3Adapter';

