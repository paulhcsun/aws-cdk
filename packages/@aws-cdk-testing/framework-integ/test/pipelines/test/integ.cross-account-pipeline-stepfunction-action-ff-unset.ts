import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as integ from '@aws-cdk/integ-tests-alpha';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';

export class StepFunctionStack extends cdk.Stack {
  public readonly stepFunctionArn: string;
  public readonly crossAccountRoleArn: string;

  constructor(scope: cdk.App, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const task = new sfn.Pass(this, 'SimplePassFFunset');
    const stateMachine = new sfn.StateMachine(this, 'CrossAccountStateMachineFFunset', {
      stateMachineName: 'MyCrossAccountStateMachineFFunset',
      definition: task,
    });

    const trustedAccountId = '924310372990'; // Pipeline account

    const crossAccountRole = new iam.Role(this, 'CrossAccountInvocationRoleFFunset', {
      roleName: 'StepFunctionInvocationRoleFFunset',
      assumedBy: new iam.AccountPrincipal(trustedAccountId),
    });
    stateMachine.grantStartExecution(crossAccountRole);

    this.stepFunctionArn = stateMachine.stateMachineArn;
    this.crossAccountRoleArn = crossAccountRole.roleArn;
  }
}
export interface PipelineStackProps extends cdk.StackProps {
  stepFunctionArn: string;
  crossAccountRoleArn: string;
}
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const sourceOutput = new codepipeline.Artifact();

    const pipeline = new codepipeline.Pipeline(this, 'CrossAccountPipelineFFunset', {
      pipelineName: 'CrossAccountPipelineFFunset',
    });
    const githubSourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: 'GitHub_Source',
      owner: 'QuantumNeuralCoder',
      repo: 'my-simple-cdkapp',
      branch: 'main',
      oauthToken: cdk.SecretValue.secretsManager('github-token'),
      output: sourceOutput,
    });
    // Add source stage with GitHub
    pipeline.addStage({
      stageName: 'Source',
      actions: [githubSourceAction],
    });
    const triggerStepFunctionProject = new codebuild.PipelineProject(this, 'TriggerStepFunctionProjectFFunset', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              // Install jq if not already in image
              'npm install -y jq',
            ],
          },
          build: {
            commands: [
              'echo "Assuming cross-account role..."',
              `CREDS=$(aws sts assume-role --role-arn ${props.crossAccountRoleArn} --role-session-name CrossAccountInvokeSession)`,
              'export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r \'.Credentials.AccessKeyId\')',
              'export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | jq -r \'.Credentials.SecretAccessKey\')',
              'export AWS_SESSION_TOKEN=$(echo $CREDS | jq -r \'.Credentials.SessionToken\')',
              'echo "Starting Step Function execution..."',
              `aws stepfunctions start-execution --state-machine-arn ${props.stepFunctionArn} --region us-east-1`,
            ],
          },
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        privileged: true,
      },
    });

    triggerStepFunctionProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [props.crossAccountRoleArn],
    }));

    pipeline.addStage({
      stageName: 'TriggerStepFunctionFFunset',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'InvokeStepFunctionFFunset',
          project: triggerStepFunctionProject,
          input: sourceOutput,
        }),
      ],
    });
  }
}

const app = new cdk.App({
  postCliContext: {
    '@aws-cdk/pipelines:reduceStageRoleTrustScope': false,
  },
});

const stepFunctionStack = new StepFunctionStack(app, 'StepFunctionStackFFunset', {
  env: { account: '813021164746', region: 'us-east-1' },
});

const pipelineStack = new PipelineStack(app, 'PipelineStackFFunset', {
  env: { account: '924310372990', region: 'us-east-1' },
  stepFunctionArn: stepFunctionStack.stepFunctionArn,
  crossAccountRoleArn: stepFunctionStack.crossAccountRoleArn,
});

pipelineStack.addDependency(stepFunctionStack, 'coz pipelineaction refers stepfunction');
new integ.IntegTest(app, 'CodePipelineSFActionTestFFunset', {
  testCases: [stepFunctionStack, pipelineStack],
  diffAssets: true,
});

app.synth();
