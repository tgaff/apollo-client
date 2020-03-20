import { print } from 'graphql/language/printer';
import { getOperationAST } from 'graphql';

import stringify from 'fast-json-stable-stringify';
import { equal } from '@wry/equality';

import { Observable } from '../../../utilities/observables/Observable';
import { ApolloLink } from '../../../link/core/ApolloLink';
import {
  Operation,
  GraphQLRequest,
  FetchResult,
} from '../../../link/core/types';
import {
  addTypenameToDocument,
  removeClientSetsFromDocument,
  removeConnectionDirectiveFromDocument,
} from '../../../utilities/graphql/transform';
import { cloneDeep } from '../../../utilities/common/cloneDeep';
import values from 'lodash/values';
import isEqual from 'lodash/isEqual';
import diff from 'jest-diff';

export type ResultFunction<T> = () => T;

export interface MockedResponse {
  request: GraphQLRequest;
  result?: FetchResult | ResultFunction<FetchResult>;
  error?: Error;
  delay?: number;
  newData?: ResultFunction<FetchResult>;
}

function requestToKey(request: GraphQLRequest, addTypename: Boolean): string {
  const queryString =
    request.query &&
    print(addTypename ? addTypenameToDocument(request.query) : request.query);
  const requestKey = { query: queryString };
  return JSON.stringify(requestKey);
}

export class MockLink extends ApolloLink {
  public operation: Operation;
  public addTypename: Boolean = true;
  private mockedResponsesByKey: { [key: string]: MockedResponse[] } = {};

  constructor(
    mockedResponses: ReadonlyArray<MockedResponse>,
    addTypename: Boolean = true
  ) {
    super();
    this.addTypename = addTypename;
    if (mockedResponses) {
      mockedResponses.forEach(mockedResponse => {
        this.addMockedResponse(mockedResponse);
      });
    }
  }

  public addMockedResponse(mockedResponse: MockedResponse) {
    const normalizedMockedResponse = this.normalizeMockedResponse(
      mockedResponse
    );
    const key = requestToKey(
      normalizedMockedResponse.request,
      this.addTypename
    );
    let mockedResponses = this.mockedResponsesByKey[key];
    if (!mockedResponses) {
      mockedResponses = [];
      this.mockedResponsesByKey[key] = mockedResponses;
    }
    mockedResponses.push(normalizedMockedResponse);
  }

  public request(operation: Operation): Observable<FetchResult> | null {
    this.operation = operation;
    const key = requestToKey(operation, this.addTypename);
    let responseIndex;
    const response = (this.mockedResponsesByKey[key] || []).find(
      (res, index) => {
        const requestVariables = operation.variables || {};
        const mockedResponseVariables = res.request.variables || {};
        if (
          !equal(
            stringify(requestVariables),
            stringify(mockedResponseVariables)
          )
        ) {
          return false;
        }
        responseIndex = index;
        return true;
      }
    );

    if (!response || typeof responseIndex === 'undefined') {
    
      const queryDiffs = (<string[]> []).concat(
         ...values(this.mockedResponsesByKey).map(mockedResponses =>
           mockedResponses.map(mockedResponse =>
             diffRequest(mockedResponse.request, operation, this.addTypename),
           ),
         ),
       );

 


      this.onError(new Error(
        `No more mocked responses for ${requestToString(operation)}${
           queryDiffs.length ? `\n\nPossible matches:\n${queryDiffs.join('\n')}` : ''
         }`, 

      ));
    }

    this.mockedResponsesByKey[key].splice(responseIndex, 1);

    const { newData } = response;

    if (newData) {
      response.result = newData();
      this.mockedResponsesByKey[key].push(response);
    }

    const { result, error, delay } = response;

    if (!result && !error) {
      this.onError(new Error(
        `Mocked response should contain either result or error: ${key}`
      ));
    }

    return new Observable(observer => {
      let timer = setTimeout(
        () => {
          if (error) {
            observer.error(error);
          } else {
            if (result) {
              observer.next(
                typeof result === 'function'
                  ? (result as ResultFunction<FetchResult>)()
                  : result
              );
            }
            observer.complete();
          }
        },
        delay ? delay : 0
      );

      return () => {
        clearTimeout(timer);
      };
    });
  }

  private normalizeMockedResponse(
    mockedResponse: MockedResponse
  ): MockedResponse {
    const newMockedResponse = cloneDeep(mockedResponse);
    newMockedResponse.request.query = removeConnectionDirectiveFromDocument(
      newMockedResponse.request.query
    );
    const query = removeClientSetsFromDocument(newMockedResponse.request.query);
    if (query) {
      newMockedResponse.request.query = query;
    }
    return newMockedResponse;
  }
}

function diffRequest(
   actualRequest: GraphQLRequest,
   expectedRequest: GraphQLRequest,
   addTypename?: Boolean
 ): string {
   return diff(
     requestToString(actualRequest, addTypename),
     requestToString(expectedRequest)
   ) || '';
 }

 function requestToString(
   request: GraphQLRequest,
   addTypename?: Boolean
 ): string {
   const query = print(
     addTypename ? addTypenameToDocument(request.query) : request.query
   );
   const variables = request.variables
     ? JSON.stringify(request.variables, null, 2)
     : '{}';
   const operationAST = getOperationAST(request.query, null);
   const operationName = operationAST ? operationAST.operation : 'query';
   return `${operationName}:\n${query}variables:\n${variables}`;
 }


interface MockApolloLink extends ApolloLink {
  operation?: Operation;
}

// Pass in multiple mocked responses, so that you can test flows that end up
// making multiple queries to the server.
// NOTE: The last arg can optionally be an `addTypename` arg.
export function mockSingleLink(
  ...mockedResponses: Array<any>
): MockApolloLink {
  // To pull off the potential typename. If this isn't a boolean, we'll just
  // set it true later.
  let maybeTypename = mockedResponses[mockedResponses.length - 1];
  let mocks = mockedResponses.slice(0, mockedResponses.length - 1);

  if (typeof maybeTypename !== 'boolean') {
    mocks = mockedResponses;
    maybeTypename = true;
  }

  return new MockLink(mocks, maybeTypename);
}
