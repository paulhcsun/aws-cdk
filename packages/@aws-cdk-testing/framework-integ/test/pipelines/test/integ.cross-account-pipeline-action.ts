import * as cdk from 'aws-cdk-lib';
import { App, Stack, StackProps, Stage, StageProps } from 'aws-cdk-lib';
import * as integ from '@aws-cdk/integ-tests-alpha';
import { Construct } from 'constructs';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

const PIPELINE_ACCOUNT = '924310372990';
const SOURCE_ACCOUNT = '813021164746';
const DEV_ACCOUNT = PIPELINE_ACCOUNT;
const QA_ACCOUNT = DEV_ACCOUNT;
const STAGING_ACCOUNT = '920372995415';
const PROD_ACCOUNT = '813021164746';
const REGION = 'us-east-1';
class SourceStack extends Stack {
  public readonly sourceBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bucketName = `itestcross-account-source-${cdk.Names.uniqueId(this).toLowerCase()}`;

    this.sourceBucket = new s3.Bucket(this, 'iSourceBucket', {
      bucketName,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, 'DeploySource', {
      sources: [s3deploy.Source.data('source.zip', 'dummy content')],
      destinationBucket: this.sourceBucket,
    });
  }
}
class AppStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new sqs.Queue(this, 'MyQueue', {
      queueName: 'prod-queue',
      visibilityTimeout: cdk.Duration.seconds(300),
    });
  }
}
class AppStage extends Stage {
  constructor(scope: Construct, id: string, props?: StageProps) {
    super(scope, id, props);
    new AppStack(this, 'AppStack', props);
  }
}
class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, sourceBucket: s3.IBucket, props?: StackProps) {
    super(scope, id, props);

    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: 'cross-account-pipeline',
      crossAccountKeys: true,
      useChangeSets: false,
      synth: new pipelines.ShellStep('Synth', {
        input: pipelines.CodePipelineSource.s3(sourceBucket, 'source.zip', {
          actionName: 'S3Source',
        }),
        commands: ['npm ci && npm run build'],
      }),
      dockerEnabledForSynth: true,
      codeBuildDefaults: {
        buildEnvironment: {
          buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
          computeType: codebuild.ComputeType.SMALL,
        },
        cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER),
      },
    });

    const devQaWave = pipeline.addWave('DEV-and-QA-Deployments');
    const dev = new AppStage(this, 'dev', {
      env: { account: DEV_ACCOUNT, region: REGION },
    });
    const qa = new AppStage(this, 'qa', {
      env: { account: QA_ACCOUNT, region: REGION },
    });
    const stg = new AppStage(this, 'stg', {
      env: { account: STAGING_ACCOUNT, region: REGION },
    });
    devQaWave.addStage(dev);
    devQaWave.addStage(qa);
    devQaWave.addStage(stg);

    const primaryRdsRegionWave = pipeline.addWave('PROD-Deployment', {
      pre: [new pipelines.ManualApprovalStep('ProdManualApproval')],
    });
    const prdPrimary = new AppStage(this, 'prd-primary', {
      env: { account: PROD_ACCOUNT, region: REGION },
    });
    primaryRdsRegionWave.addStage(prdPrimary);
  }
}

const app = new App({
  postCliContext: {
    '@aws-cdk/pipelines:reduceStageRoleTrustScope': true,
  },
});

const sourceStack = new SourceStack(app, 'my26marCrossAccountSourceStack', {
  env: {
    account: SOURCE_ACCOUNT,
    region: REGION,
  },
});

const pipelineStack = new PipelineStack(app, 'my26marCdkPipelineInvestigationStack',
  sourceStack.sourceBucket,
  {
    env: {
      account: PIPELINE_ACCOUNT,
      region: REGION,
    },
  },
);

pipelineStack.addDependency(sourceStack);

new integ.IntegTest(app, 'my26marCdkPipelineInvestigationTest', {
  testCases: [sourceStack, pipelineStack],
  diffAssets: true,
});

app.synth();
