import { Construct } from 'constructs';
import { CfnPublicKey } from './cloudfront.generated';
import { IResource, Names, Resource, Token, ValidationError } from '../../core';
import { addConstructMetadata } from '../../core/lib/metadata-resource';
import { propertyInjectable } from '../../core/lib/prop-injectable';

/**
 * Represents a Public Key
 */
export interface IPublicKey extends IResource {
  /**
   * The ID of the key group.
   * @attribute
   */
  readonly publicKeyId: string;
}

/**
 * Properties for creating a Public Key
 */
export interface PublicKeyProps {
  /**
   * A name to identify the public key.
   * @default - generated from the `id`
   */
  readonly publicKeyName?: string;

  /**
   * A comment to describe the public key.
   * @default - no comment
   */
  readonly comment?: string;

  /**
   * The public key that you can use with signed URLs and signed cookies, or with field-level encryption.
   * The `encodedKey` parameter must include `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----` lines.
   * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PrivateContent.html
   * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/field-level-encryption.html
   */
  readonly encodedKey: string;
}

/**
 * A Public Key Configuration
 *
 * @resource AWS::CloudFront::PublicKey
 */
@propertyInjectable
export class PublicKey extends Resource implements IPublicKey {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-cloudfront.PublicKey';

  /** Imports a Public Key from its id. */
  public static fromPublicKeyId(scope: Construct, id: string, publicKeyId: string): IPublicKey {
    return new class extends Resource implements IPublicKey {
      public readonly publicKeyId = publicKeyId;
    }(scope, id);
  }

  public readonly publicKeyId: string;

  constructor(scope: Construct, id: string, props: PublicKeyProps) {
    super(scope, id);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    if (!Token.isUnresolved(props.encodedKey) && !/^-----BEGIN PUBLIC KEY-----/.test(props.encodedKey)) {
      throw new ValidationError(`Public key must be in PEM format (with the BEGIN/END PUBLIC KEY lines); got ${props.encodedKey}`, scope);
    }

    const resource = new CfnPublicKey(this, 'Resource', {
      publicKeyConfig: {
        name: props.publicKeyName ?? this.generateName(),
        callerReference: this.node.addr,
        encodedKey: props.encodedKey,
        comment: props.comment,
      },
    });

    this.publicKeyId = resource.ref;
  }

  private generateName(): string {
    const name = Names.uniqueId(this);
    if (name.length > 80) {
      return name.substring(0, 40) + name.substring(name.length - 40);
    }
    return name;
  }
}
