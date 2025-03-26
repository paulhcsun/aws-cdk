import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as integ from '@aws-cdk/integ-tests-alpha';

export class CodePipelineAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Artifact buckets
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Define artifacts
    const sourceOutput = new codepipeline.Artifact();
    const synthOutput = new codepipeline.Artifact();

    // Source action (GitHub)
    const githubSourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: 'GitHub_Source',
      owner: 'QuantumNeuralCoder',
      repo: 'multiple-account-cdk-cicd-pipeline',
      branch: 'main',
      oauthToken: cdk.SecretValue.secretsManager('github-token'),
      output: sourceOutput,
    });

    // Build project for synth
    const synthProject = new codebuild.PipelineProject(this, 'SynthProject', {
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
            commands: ['npm run build', 'cdk synth > cdk.out/template.yaml'],
          },
        },
        artifacts: {
          'base-directory': 'cdk.out',
          'files': ['template.yaml'],
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

    // Deploy action
    const deployAction = new codepipeline_actions.CloudFormationCreateUpdateStackAction({
      actionName: 'CFN_Deploy',
      stackName: 'MyAppStack',
      templatePath: synthOutput.atPath('template.yaml'),
      adminPermissions: true,
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
const app = new cdk.App({
  postCliContext: {
    '@aws-cdk/pipelines:reduceStageRoleTrustScope': true,
  },
});
const sourceStack = new CodePipelineAppStack(app, 'CodePipelineAppStack', {
});

new integ.IntegTest(app, 'CdkCodePipelineInvestigationTest', {
  testCases: [sourceStack],
  diffAssets: true,
});

app.synth();

