/*
 * test/simple-scheduler.js
 *
 * Copyright (C) 2009-13 by RStudio, Inc.
 *
 * This program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */

var AppSpec = require('../lib/worker/app-spec');
var Q = require('q');
var map = require('../lib/core/map');
var _ = require('underscore');
var SimpleEventBus = require('../lib/events/simple-event-bus');
var rewire = require("rewire");
var should = require('should');
var sinon = require('sinon');
var SimpleScheduler = require('../lib/scheduler/simple-scheduler');
var WorkerEntry = require('../lib/scheduler/worker-entry');

// Setup a simple scheduler with a max of 4 requests.
var MAX_REQUESTS = 4;
var appSpec;
var key;

// Spy on the spawnWorker function.
var spawnWorkerSpy;

// Scope a scheduler var here that will be reinitialized beforeEach().
var scheduler;

// Helper function to quickly add workers to a scheduler
function addWorker(scheduler, id, sock, http, pending, isPending){
  if (!scheduler.$workers){
    scheduler.$workers = map.create();
  }

  scheduler.$workers[id] = {
    id: id,
    data: {
      sockConn: sock,
      httpConn: http,
      pendingConn: pending
    },
    promise: Q({type: "mockWorker", id: id}),
    getAppWorkerHandle_p: function() { return this.promise; },
    sessionCount: WorkerEntry.prototype.sessionCount
  };

  scheduler.spawnWorker();

  return scheduler.$workers[id];
}

describe('SimpleScheduler', function(){
  beforeEach(function(){
    scheduler = new SimpleScheduler(new SimpleEventBus(), appSpec);

    // Would be much better to use rewire to overwrite the prototype 
    // definition of this function. Unfortunately, it doesn't seem to 
    // work properly in the context of util.inherit(), and it kept calling
    // the actual spawnWorker code in Scheduler. So I'm resorting to this
    // manual override.
    scheduler.spawnWorker = function(appSpec){
      return {
        getAppWorkerHandle_p: () => Q({type: "mockWorker"})
      };
    };

    // Since we can't globally inject ourselves into scheduler, redefine
    // the spy before each test.
    spawnWorkerSpy = sinon.spy(scheduler, "spawnWorker");

    appSpec = {
      getKey: function(){return "simpleAppSpecKey"},
      settings: {appDefaults: {sessionTimeout: 10}, scheduler: 
        {simple: {maxRequests: MAX_REQUESTS}}}
    };

    var key =  appSpec.getKey();

  }),
  afterEach(function(){
    spawnWorkerSpy.resetHistory();
  }),
  describe('#acquireWorker()', function(done){
    it('should initially create a new worker.', function(){
      //request a worker
      scheduler.acquireWorker(appSpec).getAppWorkerHandle_p()
      .then(function(wh){
        spawnWorkerSpy.callCount.should.equal(1);
      })
      .then(done, done).done();
    })
    it('should not create a new worker when one exists.', function(done){
      var WORKER_ID = "WORKER";
      var mockWorker = 
        addWorker(scheduler, WORKER_ID, 0, 0, 0, false);
      
      // Reset after adding the initial worker.
      spawnWorkerSpy.resetHistory();

      scheduler.acquireWorker(appSpec).getAppWorkerHandle_p()
      .then(function(wh){
        // check that spawn() wasn't called when a
        // worker already existed
        spawnWorkerSpy.callCount.should.equal(0);

        wh.id.should.equal(mockWorker.id);
      })
      .then(done, done).done();

    })
    it('should not limit if there is no max but should choose less busy one', function(done){
      var WORKER_ID = "WORKER";

      _.times(7, function(){addWorker(scheduler, WORKER_ID + Math.random(), 100, 0, 0, false)});
      var mockWorker = 
        addWorker(scheduler, WORKER_ID, 10, 0, false);
      
      // Reset after adding the initial worker.
      spawnWorkerSpy.resetHistory();

      appSpec.settings.scheduler = {simple: {maxRequests: 0}};
      scheduler.acquireWorker(appSpec).getAppWorkerHandle_p()
      .then(function(wh){
        // ensure there's no error and that we got the right
        // data back.
        wh.id.should.equal(mockWorker.id);
      })
      .then(done, done).done();
    })
    it('should approach the MAX_REQUESTS directive.', function(done){
      var WORKER_ID = "WORKER";
      var mockWorker = 
        addWorker(scheduler, WORKER_ID, MAX_REQUESTS - 1, 0, 0, false);

      //request a worker for the new app
      scheduler.acquireWorker(appSpec, '/').getAppWorkerHandle_p()
      .then(function(wh){
        // should succeed, there's room for one more.
        wh.id.should.equal(mockWorker.id);
      })
      .then(done, done).done();
    })
    it('should not let an http connection use a pending conn count.', function() {
      var WORKER_ID = "WORKER";
      _.times(7, function(){addWorker(scheduler, WORKER_ID + Math.random(), MAX_REQUESTS, 0, 0, false)});
      var mockWorker = 
        addWorker(scheduler, WORKER_ID, MAX_REQUESTS - 1, 0, 1, false);

      //request a worker for the new app
      (() => {
        scheduler.acquireWorker(appSpec, '/').getAppWorkerHandle_p();
      }).should.throw();
    })
    it('should let a sockjs connection use a pending conn count.', function(done){
      var WORKER_ID = "WORKER";
      _.times(7, function(){addWorker(scheduler, WORKER_ID + Math.random(), MAX_REQUESTS, 0, 0, false)});
      var mockWorker =
          addWorker(scheduler, WORKER_ID, MAX_REQUESTS-1, 0, 1, false);

      //request a worker for the new app
      scheduler.acquireWorker(appSpec, 'ws').getAppWorkerHandle_p()
      .then(function(wh){
        // should succeed, there's room for one more.
        wh.id.should.equal(mockWorker.id);
      })
      .then(done, done).done();
    })
    it('should not exceed the MAX_REQUESTS directive on the base URL.', function(){
      var WORKER_ID = "WORKER";
      _.times(8, function(){addWorker(scheduler, WORKER_ID + Math.random(), MAX_REQUESTS, 0, 0, false)});

      //request a worker for the new app
      (function(){
        scheduler.acquireWorker(appSpec, '/').getAppWorkerHandle_p()
      }).should.throw();
    })
    it('should not 503 non-/, non-ws traffic ever', function(done){
      var WORKER_ID = "WORKER";
      _.times(8, function(){addWorker(scheduler, WORKER_ID + Math.random(), MAX_REQUESTS * 3, 0, 0, false)});
      var mockWorker = 
        addWorker(scheduler, WORKER_ID, MAX_REQUESTS * 2, 0, 0, false);

      appSpec.settings.scheduler = {simple: {maxRequests: 0}};

      scheduler.acquireWorker(appSpec, 'SOMEURL').getAppWorkerHandle_p()
      .then(function(wh){
        // ensure there's no error and that we got the right
        // data back.
        wh.id.should.equal(mockWorker.id);
      })
      .then(done, done).done();
    })
    it('should not assign traffic to a kill()ed worker before the process exits', () => {
      
    })
  })
})
