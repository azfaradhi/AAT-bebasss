export type ClientScope = 'media' | 'lapangan' | 'internal';
export type Permission = 'field-reports:write' | 'ops:read' | 'ops:replay';

export interface ClientAccessTokenClaims {
  sub: string;            // client_id
  scope: ClientScope;
  permissions?: Permission[];
  aud: 'bnpb-client';
  purpose: 'access';
  iat: number;
  exp: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope?: ClientScope;
  permissions?: Permission[];
}

export interface ClientRefreshTokenClaims {
  sub: string;
  scope: ClientScope;
  aud: 'bnpb-client';
  purpose: 'refresh';
  iat: number;
  exp: number;
}
