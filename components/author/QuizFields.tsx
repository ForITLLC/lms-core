"use client";

import { useId } from "react";
import type { QuizQuestion } from "@/lib/schema/quiz";
import {
  QUESTION_LABELS,
  blankQuestion,
  moved,
  nextChoiceId,
  questionLimit,
  type BlockOf,
  type ChoiceQuestion,
  type QuestionOf,
} from "./draft-helpers";
import { CheckboxField, IconButton, INPUT, NumberField, TextAreaField } from "./fields";

type Quiz = BlockOf<"quiz">;

export default function QuizFields({ value, onChange }: { value: Quiz; onChange: (next: Quiz) => void }) {
  const setQuestions = (questions: QuizQuestion[]) => onChange({ ...value, questions });
  const replace = (index: number, question: QuizQuestion) =>
    setQuestions(value.questions.map((q, i) => (i === index ? question : q)));
  const full = questionLimit(value.questions.length);

  return (
    <div className="space-y-4">
      <NumberField
        label="Passing score (%)"
        value={value.passingScore}
        min={1}
        max={100}
        onChange={(passingScore) => onChange({ ...value, passingScore: passingScore ?? Number.NaN })}
      />
      <CheckboxField
        label="This quiz is an exam"
        hint="Attempts at an exam go into the learner's training record, and they are kept: they can't be deleted."
        checked={value.isExam}
        onChange={(isExam) => onChange({ ...value, isExam })}
      />
      {value.questions.length === 0 ? <p className="text-sm text-gray-500">No questions yet.</p> : null}
      <ol className="space-y-3">
        {value.questions.map((question, index) => (
          <li key={index} className="rounded-md border border-gray-200 bg-white p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Question {index + 1} · {QUESTION_LABELS[question.kind]}
              </p>
              <div className="flex gap-1">
                <IconButton label="Move question up" disabled={index === 0} onClick={() => setQuestions(moved(value.questions, index, index - 1))}>
                  ↑
                </IconButton>
                <IconButton
                  label="Move question down"
                  disabled={index === value.questions.length - 1}
                  onClick={() => setQuestions(moved(value.questions, index, index + 1))}
                >
                  ↓
                </IconButton>
                <IconButton label="Remove question" tone="danger" onClick={() => setQuestions(value.questions.filter((_, i) => i !== index))}>
                  Remove
                </IconButton>
              </div>
            </div>
            <QuestionFields question={question} onChange={(next) => replace(index, next)} />
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <IconButton label="Add a true or false question" disabled={full !== null} onClick={() => setQuestions([...value.questions, blankQuestion("tf")])}>
          + True or false
        </IconButton>
        <IconButton label="Add a multiple choice question" disabled={full !== null} onClick={() => setQuestions([...value.questions, blankQuestion("mcq")])}>
          + Multiple choice
        </IconButton>
      </div>
      {full ? <p className="text-xs text-gray-600">{full}</p> : null}
    </div>
  );
}

function QuestionFields({ question, onChange }: { question: QuizQuestion; onChange: (next: QuizQuestion) => void }) {
  const prompt = (
    <TextAreaField
      label="Question"
      rows={2}
      hint="Markdown is allowed."
      value={question.promptMd}
      onChange={(promptMd) => onChange({ ...question, promptMd })}
    />
  );
  switch (question.kind) {
    case "tf":
      return (
        <div className="space-y-3">
          {prompt}
          <TrueFalseAnswer question={question} onChange={onChange} />
        </div>
      );
    case "mcq":
    case "confidence":
    case "multi":
      return (
        <div className="space-y-3">
          {prompt}
          <ChoicesEditor question={question} onChange={onChange} />
        </div>
      );
    case "short":
      return (
        <div className="space-y-3">
          {prompt}
          <TextAreaField label="Marking rubric" rows={3} value={question.rubricMd} onChange={(rubricMd) => onChange({ ...question, rubricMd })} />
          <NumberField
            label="Marks"
            value={question.maxScore}
            min={1}
            max={100}
            onChange={(maxScore) => onChange({ ...question, maxScore: maxScore ?? Number.NaN })}
          />
        </div>
      );
  }
}

function TrueFalseAnswer({ question, onChange }: { question: QuestionOf<"tf">; onChange: (next: QuizQuestion) => void }) {
  const name = useId();
  return (
    <fieldset className="text-sm">
      <legend className="font-semibold text-gray-700 mb-1">Correct answer</legend>
      <div className="flex gap-4">
        {[true, false].map((answer) => (
          <label key={String(answer)} className="flex items-center gap-2">
            <input type="radio" name={name} checked={question.correctValue === answer} onChange={() => onChange({ ...question, correctValue: answer })} />
            {answer ? "True" : "False"}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ChoicesEditor({ question, onChange }: { question: ChoiceQuestion; onChange: (next: QuizQuestion) => void }) {
  const name = useId();
  const many = question.kind === "multi";
  const isCorrect = (id: string) => (question.kind === "multi" ? question.correctChoiceIds.includes(id) : question.correctChoiceId === id);

  const toggleCorrect = (id: string) => {
    if (question.kind !== "multi") return onChange({ ...question, correctChoiceId: id });
    const ids = question.correctChoiceIds.includes(id)
      ? question.correctChoiceIds.filter((c) => c !== id)
      : [...question.correctChoiceIds, id];
    if (ids.length > 0) onChange({ ...question, correctChoiceIds: ids });
  };

  const relabel = (id: string, label: string) =>
    onChange({ ...question, choices: question.choices.map((c) => (c.id === id ? { ...c, label } : c)) });

  const add = () => onChange({ ...question, choices: [...question.choices, { id: nextChoiceId(question.choices), label: "" }] });

  const remove = (id: string) => {
    const choices = question.choices.filter((c) => c.id !== id);
    const fallback = choices[0]?.id ?? "";
    if (question.kind === "multi") {
      const left = question.correctChoiceIds.filter((c) => c !== id);
      onChange({ ...question, choices, correctChoiceIds: left.length > 0 ? left : [fallback] });
    } else {
      onChange({ ...question, choices, correctChoiceId: question.correctChoiceId === id ? fallback : question.correctChoiceId });
    }
  };

  return (
    <fieldset className="text-sm space-y-2">
      <legend className="font-semibold text-gray-700 mb-1">
        Answers <span className="font-normal text-gray-500">({many ? "tick every correct one" : "pick the correct one"})</span>
      </legend>
      {question.choices.map((choice, index) => (
        <div key={choice.id} className="flex items-center gap-2">
          <input
            type={many ? "checkbox" : "radio"}
            name={name}
            aria-label={`Answer ${index + 1} is correct`}
            checked={isCorrect(choice.id)}
            onChange={() => toggleCorrect(choice.id)}
          />
          <input
            type="text"
            aria-label={`Answer ${index + 1}`}
            value={choice.label}
            onChange={(e) => relabel(choice.id, e.target.value)}
            className={INPUT}
          />
          <IconButton label={`Remove answer ${index + 1}`} tone="danger" disabled={question.choices.length <= 2} onClick={() => remove(choice.id)}>
            ✕
          </IconButton>
        </div>
      ))}
      <IconButton label="Add an answer" onClick={add}>
        + Answer
      </IconButton>
    </fieldset>
  );
}
