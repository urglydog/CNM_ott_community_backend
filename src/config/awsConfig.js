const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { S3Client } = require('@aws-sdk/client-s3');

const region = process.env.AWS_REGION || 'ap-southeast-2';
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

const awsConfig = {
  region
};

// Thêm credentials nếu có trong environment
if (accessKeyId && secretAccessKey) {
  awsConfig.credentials = {
    accessKeyId,
    secretAccessKey
  };
}

const dynamoClient = new DynamoDBClient(awsConfig);

const ddbDocClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    removeUndefinedValues: true
  }
});

const s3Client = new S3Client(awsConfig);

module.exports = {
  dynamoClient,
  ddbDocClient,
  s3Client
};
