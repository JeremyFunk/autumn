import { HeadObjectCommand, NotFound } from "@aws-sdk/client-s3";
import { withDependencySpan } from "@/utils/otel/withDependencySpan.js";
import { getS3Client } from "./initS3.js";

export const headS3Object = async ({
	bucket,
	region,
	key,
}: {
	bucket: string;
	region: string;
	key: string;
}): Promise<{ exists: boolean; contentLength: number | null }> => {
	const client = getS3Client({ region });

	// The span wraps the not-found handling, so an absent object is not an error.
	return withDependencySpan({
		name: "s3.head_object",
		attributes: {
			"rpc.system": "aws-api",
			"rpc.service": "S3",
			"rpc.method": "HeadObject",
			"aws.s3.bucket": bucket,
		},
		fn: async () => {
			try {
				const response = await client.send(
					new HeadObjectCommand({ Bucket: bucket, Key: key }),
				);
				return { exists: true, contentLength: response.ContentLength ?? null };
			} catch (error) {
				if (error instanceof NotFound) {
					return { exists: false, contentLength: null };
				}
				throw error;
			}
		},
	});
};
