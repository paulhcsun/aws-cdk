// eslint-disable-next-line import/no-extraneous-dependencies
/// !cdk-integ CdkPipelineInvestigationTest pragma:set-context:@aws-cdk/core:newStyleStackSynthesis=true

import * as s3 from 'aws-cdk-lib/aws-s3';
import {
  App,
  Stack,
  StackProps,
  Stage,
  StageProps,
  RemovalPolicy,
  Duration,
} from 'aws-cdk-lib';
import * as integ from '@aws-cdk/integ-tests-alpha';
import { Construct } from 'constructs';
import * as pipelines from 'aws-cdk-lib/pipelines';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Cache, ComputeType, LinuxArmBuildImage, LocalCacheMode } from 'aws-cdk-lib/aws-codebuild';

/**
 * Stack that represents a production deployment
 */
export class ProdStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new Queue(this, 'IntegMyQueue', {
      queueName: 'prod-queue',
      visibilityTimeout: Duration.seconds(300),
    });
  }
}

/**
 * Stage representing production deployment
 */
export class ProdStage extends Stage {
  constructor(scope: Construct, id: string, props?: StageProps) {
    super(scope, id, props);
    new ProdStack(this, 'ProdStack', { env: props?.env });
  }
}

/**
 * Stack that defines a pipeline
 */
class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create an S3 bucket to act as a source
    const sourceBucket = new s3.Bucket(this, 'IntegSourceBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Define pipeline source from S3 bucket
    const pipelineSource = pipelines.CodePipelineSource.s3(sourceBucket, 'key');

    // Define the pipeline
    const pipeline = new pipelines.CodePipeline(this, 'IntegPipeline', {
      pipelineName: 'pipeline-name-integ',
      useChangeSets: false,
      selfMutation: false, // Disabled for testing
      crossAccountKeys: false,
      synth: new pipelines.ShellStep('Synth', {
        input: pipelineSource,
        commands: ['mkdir cdk.out', 'touch cdk.out/dummy'],
      }),
      dockerEnabledForSynth: true,
      codeBuildDefaults: {
        buildEnvironment: {
          buildImage: LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
          computeType: ComputeType.SMALL,
        },
        cache: Cache.local(LocalCacheMode.DOCKER_LAYER),
      },
    });

    // Add a production stage with manual approval
    pipeline.addStage(new ProdStage(this, 'Prod'), {
      pre: [new pipelines.ManualApprovalStep('PromoteToProd')],
    });
  }
}

// Initialize the app with context settings
const app = new App({
  postCliContext: {
    '@aws-cdk/core:newStyleStackSynthesis': '1',
    '@aws-cdk/aws-codepipeline:defaultPipelineTypeToV2': false,
  },
});

// Create the pipeline stack
const pipelineStack = new PipelineStack(app, 'pipelineInvestigationStack');

// Define an integration test for the pipeline stack
new integ.IntegTest(app, 'CdkPipelineInvestigationTestCDKINTEG', {
  testCases: [pipelineStack],
  diffAssets: true,
});

// Synthesize the CDK app
app.synth();
