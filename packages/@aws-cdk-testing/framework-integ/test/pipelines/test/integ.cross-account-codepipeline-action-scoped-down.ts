import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as integ from '@aws-cdk/integ-tests-alpha';
import * as kms from 'aws-cdk-lib/aws-kms';

export interface CodePipelineAppStackProps extends cdk.StackProps {
  crossAccountRole: iam.Role;
}
export class CodePipelineAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CodePipelineAppStackProps) {
    super(scope, id, props);
    const encryptionKey = new kms.Key(this, 'ArtifactBucketKey', {
    });
    const bucketName = `test-bucket-xaccnt-scdwn-${cdk.Names.uniqueId(this).toLowerCase()}`;
    // Artifact buckets
    const artifactBucket = new s3.Bucket(this, 'ScDwnArtifactBucket', {
      bucketName: bucketName,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryptionKey: encryptionKey,
    });

    // Define artifacts
    const sourceOutput = new codepipeline.Artifact();
    const synthOutput = new codepipeline.Artifact();

    // Source action (GitHub)
    const githubSourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: 'GitHub_Source',
      owner: 'QuantumNeuralCoder',
      repo: 'my-simple-cdkapp',
      branch: 'main',
      oauthToken: cdk.SecretValue.secretsManager('github-token'),
      output: sourceOutput,
    });

    // Build project for synth
    const synthProject = new codebuild.PipelineProject(this, 'ScDwnSynthProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: ['npm install -g aws-cdk', 'npm ci'],
          },
          build: {
            commands: ['npm run build', 'cdk synth'],
          },
        },
        artifacts: {
          'base-directory': 'cdk.out',
          'files': ['MySimpleCdkappStack.template.json', 'MySimpleCdkappStack.assets.json', 'manifest.json', 'tree.json'],
        },
      }),
    });

    // Add permissions to allow deployment
    synthProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudformation:*', 's3:*', 'iam:*'],
      resources: ['*'],
    }));

    // Synth action
    const synthAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'Synth_CDK',
      project: synthProject,
      input: sourceOutput,
      outputs: [synthOutput],
    });

    const myrole = props.crossAccountRole;
    const deployAction = new codepipeline_actions.CloudFormationCreateUpdateStackAction({
      actionName: 'Deploy',
      stackName: 'ScDwnMyCrossAccountStack',
      templatePath: synthOutput.atPath('MySimpleCdkappStack.template.json'),
      adminPermissions: true,
      role: myrole,
    });

    // Pipeline
    new codepipeline.Pipeline(this, 'MyPipeline', {
      artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [githubSourceAction],
        },
        {
          stageName: 'Build',
          actions: [synthAction],
        },
        {
          stageName: 'Deploy',
          actions: [deployAction],
        },
      ],
    });
  }
}

export class TargetAccountRoleStack extends cdk.Stack {
  public readonly crossAccountRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const trustedAccountId = '924310372990'; // Pipeline account

    const crossAccountRole = new iam.Role(this, 'my26marscdwnCrossAccountDeploymentRole', {
      roleName: 'my26marscdwnCrossAccountDeploymentRole',
      assumedBy: new iam.AccountPrincipal(trustedAccountId),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
      ],
    });
    // crossAccountRole.grantPassRole(new iam.AccountPrincipal(trustedAccountId));
    this.crossAccountRole = crossAccountRole;
    new cdk.CfnOutput(this, 'my26marscdwnCrossAccountDeploymentRoleArn', {
      value: crossAccountRole.roleArn,
      exportName: 'my26marscdwnCrossAccountDeploymentRoleArn',
    });
  }
}

const app = new cdk.App({
  postCliContext: {
    '@aws-cdk/pipelines:reduceStageRoleTrustScope': true,
  },
});
const targetStack = new TargetAccountRoleStack(app, 'my26marscdwnDeployActionStack', {
  env: { account: '813021164746', region: 'us-east-1' },
});

const sourceStack = new CodePipelineAppStack(app, 'my26marscdwnCodePipelineActionAppStack', {
  env: { account: '924310372990', region: 'us-east-1' },
  crossAccountRole: targetStack.crossAccountRole,
});

sourceStack.addDependency(targetStack);

new integ.IntegTest(app, 'ScDwnCdkCodePipelineActionTest', {
  testCases: [sourceStack, targetStack],
  diffAssets: true,
});

app.synth();

