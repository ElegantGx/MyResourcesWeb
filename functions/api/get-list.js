import { Buffer } from 'node:buffer';
import * as util from 'node:util';
import COS from "cos-nodejs-sdk-v5";

export async function onRequest(context) {
    const { env, data } = context;
    const auth = data?.auth;
    if (!auth?.userId) {
        return jsonResponse({ error: "Unauthorized", message: "Missing or invalid auth context." }, 401);
    }
    const {
        COS_SECRET_ID,
        COS_SECRET_KEY,
        COS_BUCKET,
        COS_REGION,
        COS_CUSTOM_DOMAIN,
    } = env;

    if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET || !COS_REGION) {
        return jsonResponse({ error: "Configuration Error", message: "Missing required COS environment variables." }, 500);
    }
    const cos = new COS({
        SecretId: COS_SECRET_ID,
        SecretKey: COS_SECRET_KEY,
    });
    
    let bucketContents;
    try {
        const bucketData = await getBucket(cos, { Bucket: COS_BUCKET, Region: COS_REGION });
        bucketContents = bucketData.Contents ?? [];
    } catch (err) {
        return jsonResponse(
            { error: "COS Error", message: "Failed to retrieve bucket list.", detail: err.message ?? String(err) },
            502
        );
    }
  
    let files;
    try {
        files = await Promise.all(
            bucketContents.map(async (item) => {
                const signedUrl = await getObjectUrl(cos, {
                    Bucket: COS_BUCKET,
                    Region: COS_REGION,
                    Key: item.Key,
                    Domain: COS_CUSTOM_DOMAIN ?? "cdn.gxweb.top",
                    Expires: 3600,
                    Sign: true,
                });

                return {
                    Key: item.Key,
                    Size: item.Size,
                    LastModified: item.LastModified,
                    Url: signedUrl,
                };
            })
        );
    } catch (err) {
        return jsonResponse(
            { error: "Signing Error", message: "Failed to generate signed URLs.", detail: err.message ?? String(err) },
            502
        );
    }
  
    return jsonResponse({
        success: true,
        total: files.length,
        files,
    }, 200);
}

function getBucket(cos, params) {
    return new Promise((resolve, reject) => {
        cos.getBucket(params, (err, data) => {
            if (err) return reject(err);
            resolve(data);
        });
    });
}

function getObjectUrl(cos, params) {
    return new Promise((resolve, reject) => {
        cos.getObjectUrl(params, (err, data) => {
            if (err) return reject(err);
            resolve(data.Url);
        });
    });
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
