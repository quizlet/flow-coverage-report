'use babel';

/* eslint-disable react/jsx-filename-extension */

import {test} from 'ava';

import React from 'react';
import {shallow, render} from 'enzyme';

const BASE_DIR = '../../../src/components/flow-coverage-html-report';

const REACT_COMPONENT = `${BASE_DIR}/coverage-file-table-head`;

test('<FlowCoverageFileTableHead />', t => {
  const FlowCoverageFileTableHead = require(REACT_COMPONENT);
  const wrapper = render(<FlowCoverageFileTableHead/>);

  const expectedKeys = [
    'filename', 'percent', 'total', 'covered', 'uncovered'
  ];

  t.is(wrapper.find('thead').length, 1);
  t.is(wrapper.find('tr').length, 1);
  t.is(wrapper.find('th').length, expectedKeys.length);

  const shallowWrapper = shallow(<FlowCoverageFileTableHead/>);

  let i = 0;
  for (const expectedKey of expectedKeys) {
    t.is(shallowWrapper.find('th').at(i).key(), expectedKey);
    i++;
  }
});

test.todo('<FlowCoverageFileTableHead /> with missing props');