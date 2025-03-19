import * as cdk from 'aws-cdk-lib';
import { App, Stack, StackProps, Stage, StageProps } from 'aws-cdk-lib';
import * as integ from '@aws-cdk/integ-tests-alpha';
import { Construct } from 'constructs';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

const PRIMARY_ACCOUNT = '486673125664';
const SECONDARY_ACCOUNT = '257030043956';
const REGION = 'us-east-1';

class SourceStack extends Stack {
  public readonly sourceBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bucketName = `cross-account-source-${cdk.Names.uniqueId(this).toLowerCase()}`;

    this.sourceBucket = new s3.Bucket(this, 'SourceBucket', {
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

class ProdStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new sqs.Queue(this, 'MyQueue', {
      queueName: 'prod-queue',
      visibilityTimeout: cdk.Duration.seconds(300),
    });
  }
}

class ProdStage extends Stage {
  constructor(scope: Construct, id: string, props?: StageProps) {
    super(scope, id, props);
    new ProdStack(this, 'ProdStack', props);
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

    pipeline.addStage(new ProdStage(this, 'Prod'), {
      pre: [new pipelines.ManualApprovalStep('PromoteToProd')],
    });
  }
}

const app = new App({
  postCliContext: {
    '@aws-cdk/pipelines:reduceStageRoleTrustScope': true,
  },
});

const sourceStack = new SourceStack(app, 'CrossAccountSourceStack', {
  env: {
    account: SECONDARY_ACCOUNT,
    region: REGION,
  },
});

const pipelineStack = new PipelineStack(app, 'CdkPipelineInvestigationStack',
  sourceStack.sourceBucket,
  {
    env: {
      account: PRIMARY_ACCOUNT,
      region: REGION,
    },
  },
);

pipelineStack.addDependency(sourceStack);

new integ.IntegTest(app, 'CdkPipelineInvestigationTest', {
  testCases: [sourceStack, pipelineStack],
  diffAssets: true,
});

app.synth();
