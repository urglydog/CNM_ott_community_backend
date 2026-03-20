const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { S3Client } = require('@aws-sdk/client-s3');

const region = process.env.AWS_REGION || 'ap-southeast-1';

const dynamoClient = new DynamoDBClient({
  region
});

const ddbDocClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    removeUndefinedValues: true
  }
});

const s3Client = new S3Client({
  region
});

module.exports = {
  dynamoClient,
  ddbDocClient,
  s3Client
};
