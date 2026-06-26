import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { swaggerSpec } from './swagger.config';

type HttpMethod = 'get' | 'post' | 'put';

const EXPECTED_OPERATIONS: Record<string, HttpMethod[]> = {
  '/api/health': ['get'],
  '/api/auth/signup': ['post'],
  '/api/auth/login': ['post'],
  '/api/auth/me': ['get'],
  '/api/customers': ['get'],
  '/api/orders': ['get'],
  '/api/orders/{id}': ['get'],
  '/api/orders/{id}/confirm': ['post'],
  '/api/orders/{id}/cancel': ['post'],
  '/api/orders/{id}/remind': ['post'],
  '/api/messages': ['get'],
  '/api/messages/{id}': ['get'],
  '/api/messages/{id}/retry': ['post'],
  '/api/webhooks/shopify/orders-create': ['post'],
  '/api/webhooks/whatsapp': ['get', 'post'],
  '/api/whatsapp/templates': ['get'],
  '/api/whatsapp/message-config': ['get', 'put']
};

const PROTECTED_OPERATIONS: Array<[string, HttpMethod]> = [
  ['/api/auth/me', 'get'],
  ['/api/customers', 'get'],
  ['/api/orders', 'get'],
  ['/api/orders/{id}', 'get'],
  ['/api/orders/{id}/confirm', 'post'],
  ['/api/orders/{id}/cancel', 'post'],
  ['/api/orders/{id}/remind', 'post'],
  ['/api/messages', 'get'],
  ['/api/messages/{id}', 'get'],
  ['/api/messages/{id}/retry', 'post'],
  ['/api/whatsapp/templates', 'get'],
  ['/api/whatsapp/message-config', 'get'],
  ['/api/whatsapp/message-config', 'put']
];

const document = swaggerSpec as Record<string, any>;
const paths = document.paths as Record<string, Record<string, { security?: unknown[]; responses?: object }>>;

describe('Swagger MVP specification', () => {
  it('is a valid OpenAPI document', async () => {
    await expect(SwaggerParser.validate(swaggerSpec as never)).resolves.toBeDefined();
  });

  it('documents every mounted API operation', () => {
    for (const [path, methods] of Object.entries(EXPECTED_OPERATIONS)) {
      expect(paths[path]).toBeDefined();

      for (const method of methods) {
        expect(paths[path][method]).toBeDefined();
      }
    }

    const operationCount = Object.values(EXPECTED_OPERATIONS).reduce((total, methods) => total + methods.length, 0);
    const documentedCount = Object.values(paths).reduce(
      (total, path) => total + Object.keys(path).filter(key => ['get', 'post', 'put', 'patch', 'delete'].includes(key)).length,
      0
    );

    expect(documentedCount).toBe(operationCount);
  });

  it('applies Bearer JWT to every protected helpdesk operation', () => {
    for (const [path, method] of PROTECTED_OPERATIONS) {
      expect(paths[path][method].security).toEqual([{ bearerAuth: [] }]);
    }

    expect(paths['/api/whatsapp/message-config'].put.responses).toHaveProperty('403');
  });

  it('includes step 16 delivery fields and no starter metadata', () => {
    const orderProperties = document.components.schemas.Order.properties;

    expect(orderProperties).toHaveProperty('deliveryRegion');
    expect(orderProperties).toHaveProperty('deliveryRegionCode');
    expect(orderProperties).toHaveProperty('deliveryPreferredMoment');
    expect(orderProperties).toHaveProperty('deliveryLatitude');
    expect(document.info.title).not.toMatch(/starter/i);
    expect(document.info.description).not.toMatch(/starter/i);
  });

  it('keeps OpenAPI comments in compiled route documentation', () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
    const loadedConfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(loadedConfig.config, ts.sys, projectRoot);
    const source = fs.readFileSync(path.join(__dirname, 'routes/health.docs.ts'), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: parsedConfig.options }).outputText;

    expect(parsedConfig.options.removeComments).toBe(false);
    expect(output).toContain('@openapi');
  });

  it('documents strict message variants and template limit errors', () => {
    expect(document.components.schemas.RegionVariant.additionalProperties).toBe(false);
    expect(paths['/api/whatsapp/templates'].get.responses).toHaveProperty('400');
  });
});
